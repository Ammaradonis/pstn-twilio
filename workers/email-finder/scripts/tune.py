"""Offline calibration against frozen research evidence, with grouped holdouts.

No network, DNS or browser calls. Uses the production scorer, not a replacement.
Labels are weak website-evidence proxies, NOT verified email/owner ground truth.
Training selects weights; validation and final holdout gate adoption. No search
over parameters is performed using either holdout.
"""
from __future__ import annotations
import argparse
from collections import Counter
import csv
from dataclasses import asdict
import hashlib
import itertools
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.engine import Engine, Row, _Job, _registered, DESIGNER_CONTEXT
from email_finder.extract import Candidate
from email_finder.nlp import Person
from email_finder.scoring import ScoreWeights, PARAMETERS_PATH
from email_finder.sources import SOCIAL_HOSTS, PLATFORM_HOSTS, host_matches
from email_finder.validate import plausible

GRID = {"decision_bonus": [20, 25, 30], "own_domain_bonus": [20, 25, 30],
        "free_mail_with_own_bonus": [0, 4, 8], "minimum_score": [50, 55, 60]}


def identity_keys(record):
    row = record["row"]
    phone = re.sub(r"\D", "", row["phone"])
    if len(phone) == 10:
        phone = "1" + phone
    keys = ["phone:" + phone] if len(phone) >= 7 else []
    for website in (row["website"], row["facebook"], row["instagram"]):
        if website:
            parsed = urlsplit(website if "://" in website else "https://" + website)
            host = (parsed.hostname or "").lower()
            if host_matches(host, SOCIAL_HOSTS | PLATFORM_HOSTS):
                keys.append("profile:" + host.removeprefix("www.") + parsed.path.rstrip("/") + "?" + parsed.query)
            else:
                keys.append("domain:" + _registered(host))
    return keys or ["row:" + json.dumps(row, sort_keys=True)]


def grouped_splits(records, seed):
    parent = list(range(len(records)))
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    seen = {}
    for i, record in enumerate(records):
        for key in identity_keys(record):
            if key in seen:
                parent[root(i)] = root(seen[key])
            else:
                seen[key] = i
    members = {}
    for i, record in enumerate(records):
        members.setdefault(root(i), []).append(record["id"])
    assignments = {}
    for ids in members.values():
        group = min(ids)
        value = int(hashlib.sha256(f"{seed}:{group}".encode()).hexdigest()[:12], 16) % 100
        split = "train" if value < 60 else "validation" if value < 80 else "test"
        for identity in ids:
            assignments[identity] = split
    return assignments


def prepare(record):
    engine = Engine(None, SimpleNamespace(enabled=False), None, scoring=ScoreWeights())
    job = _Job(engine, Row(**record["row"]))
    for name in ("site_host", "site_domain", "site_is_schools"):
        setattr(job, name, record[name])
    job.own_domains = set(record["own_domains"])
    persons = [Person(**p) for p in record["persons"]]
    job._persons_cache = persons
    grouped = {}
    for raw in record["candidates"]:
        candidate = Candidate(**raw)
        if plausible(candidate.email):
            grouped.setdefault(candidate.email, []).append(candidate)
    own = any(_registered(email.split("@")[1]) in job.own_domains for email in grouped)
    candidates = []
    # Score at zero and one to extract exact linear contributions once. Labels
    # depend on direct evidence, never on a model's predicted kind or confidence.
    zero = ScoreWeights(decision_bonus=0, own_domain_bonus=0, free_mail_with_own_bonus=0)
    for email, evidence in grouped.items():
        if record["dns"].get(email.split("@")[1]) is not True:
            continue
        engine.scoring = zero
        scored = job._score(email, evidence, persons, own)
        if scored is None:
            continue
        features = {}
        for key in ("decision_bonus", "own_domain_bonus", "free_mail_with_own_bonus"):
            params = asdict(zero)
            params[key] = 1
            engine.scoring = ScoreWeights(**params)
            features[key] = job._score(email, evidence, persons, own).score - scored.score
        direct = [c for c in evidence if _registered(urlsplit(c.url).hostname or "") in job.own_domains
                  and c.source not in ("snippet", "directory")]
        explicit = any(c.source in ("mailto", "jsonld", "cf_decode", "spelled") for c in direct)
        matching_domain = _registered(email.split("@")[1]) in job.own_domains
        corroborated = len({c.url for c in direct}) >= 2
        # Free-mail addresses can be supported too; a business domain is not a label.
        supported = bool(direct and job.site_is_schools and
                         ((explicit and matching_domain) or (explicit and corroborated)))
        negative = not matching_domain and any(DESIGNER_CONTEXT.search(c.context) for c in evidence)
        candidates.append({"email": email, "base": scored.score, "features": features,
                           "kind": scored.kind, "url": scored.url, "supported": supported,
                           "negative": bool(negative)})
    return {"record": record, "candidates": candidates}


def predict(item, weights):
    ranked = []
    for candidate in item["candidates"]:
        score = min(99, candidate["base"] + sum(getattr(weights, k) * v for k, v in candidate["features"].items()))
        if score >= weights.minimum_score:
            ranked.append((score, candidate))
    return max(ranked, key=lambda pair: pair[0], default=(0, None))


def metrics(items, weights):
    counts = Counter()
    for item in items:
        counts["rows"] += 1
        counts["rows_with_supported_candidate"] += any(c["supported"] for c in item["candidates"])
        _, selected = predict(item, weights)
        if selected:
            counts["found"] += 1
            counts["supported"] += selected["supported"]
            counts["known_negative"] += selected["negative"]
            counts["unlabelled"] += not selected["supported"] and not selected["negative"]
            counts["decision_maker"] += selected["kind"] == "decision-maker"
    for key in ("rows", "found", "supported", "known_negative", "unlabelled", "decision_maker", "rows_with_supported_candidate"):
        counts.setdefault(key, 0)
    # A conservative coverage objective: unsupported outputs carry a cost.
    objective = (counts["supported"] - 2 * counts["known_negative"] - .25 * counts["unlabelled"]) / max(1, counts["rows"])
    return {**counts, "coverage_pct": round(100 * counts["found"] / max(1, counts["rows"]), 2),
            "weak_evidence_objective": round(objective, 8)}


def calibrate(corpus_dir: Path, apply: bool = False):
    manifest = json.loads((corpus_dir / "manifest.json").read_text(encoding="utf-8"))
    records = [json.loads(line) for line in (corpus_dir / "corpus.jsonl").read_text(encoding="utf-8").splitlines()]
    if len({r["id"] for r in records}) != len(records):
        raise ValueError("Corpus contains duplicate row identities")
    if {r["id"] for r in records} != {r["id"] for r in manifest["sample"]}:
        raise ValueError("Corpus incomplete; finish collection before tuning")
    splits = grouped_splits(records, manifest["seed"])
    items = [prepare(record) for record in records]
    subsets = {split: [item for item in items if splits[item["record"]["id"]] == split]
               for split in ("train", "validation", "test")}
    if min(len(items) for items in subsets.values()) < 20:
        raise ValueError("Too few independent rows in a holdout")
    default = ScoreWeights()
    trial_results = []
    for values in itertools.product(*GRID.values()):
        weights = ScoreWeights(**dict(zip(GRID, values)))
        trial_results.append({"weights": asdict(weights), "train": metrics(subsets["train"], weights)})
    distance = lambda p: sum(abs(p[k] - getattr(default, k)) for k in p)
    trial_results.sort(key=lambda result: (-result["train"]["weak_evidence_objective"], distance(result["weights"])))
    proposed = ScoreWeights(**trial_results[0]["weights"])
    baseline = {split: metrics(subset, default) for split, subset in subsets.items()}
    candidate = {split: metrics(subset, proposed) for split, subset in subsets.items()}
    accepted = (candidate["train"]["weak_evidence_objective"] > baseline["train"]["weak_evidence_objective"] and
                candidate["validation"]["weak_evidence_objective"] >= baseline["validation"]["weak_evidence_objective"] and
                candidate["validation"]["known_negative"] <= baseline["validation"]["known_negative"] and
                candidate["test"]["weak_evidence_objective"] >= baseline["test"]["weak_evidence_objective"] and
                candidate["test"]["known_negative"] <= baseline["test"]["known_negative"])
    chosen = proposed if accepted else default
    selected = {split: metrics(subset, chosen) for split, subset in subsets.items()}
    report = {"version": 1, "rows": len(records), "seed": manifest["seed"], "mode": manifest["mode"],
              "limitations": "Weak website evidence, not verified labels; no accuracy or mailbox deliverability claim. "
                             "Phone, domain and profile groups never cross splits. Replays the frozen candidate pool only.",
              "split_counts": dict(Counter(splits.values())), "source_counts": dict(Counter(r["source"] for r in records)),
              "collection_statuses": dict(Counter(r["status"] for r in records)),
              "pages_read": sum(r["pages_read"] for r in records),
              "rows_with_contact_form": sum(bool(r["forms"]) for r in records),
              "acceptance_criteria": "Training objective must improve; both held-out objectives must not regress, "
                                     "and neither holdout may gain designer-context selections. No retuning after rejection.",
              "parameter_combinations": len(trial_results), "baseline": baseline, "proposed": candidate,
              "selected": selected, "accepted": accepted, "weights": asdict(chosen),
              "proposed_weights": asdict(proposed),
              "by_source": {source: {"baseline": metrics([i for i in items if i['record']['source'] == source], default),
                                    "selected": metrics([i for i in items if i['record']['source'] == source], chosen)}
                            for source in sorted({r["source"] for r in records})}}
    (corpus_dir / "tuning-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (corpus_dir / "tuning-trials.json").write_text(json.dumps(trial_results, indent=2), encoding="utf-8")
    (corpus_dir / "splits.json").write_text(json.dumps(splits, indent=2), encoding="utf-8")
    lines = ["# Email engine calibration", "",
             f"Evaluated {len(records):,} randomly sampled rows with seed {manifest['seed']}.", "",
             f"Mode: {manifest['mode']}. Read {report['pages_read']:,} pages; "
             f"{report['rows_with_contact_form']:,} rows had a contact form in the collected evidence.", "",
             "These results use weak website evidence. They are not verified email or ownership accuracy.", "",
             "| Split | Rows | Baseline emails | Selected emails | Baseline evidence score | Selected evidence score |",
             "|---|---:|---:|---:|---:|---:|"]
    for split in subsets:
        before, after = baseline[split], selected[split]
        lines.append(f"| {split} | {before['rows']} | {before['found']} | {after['found']} | "
                     f"{before['weak_evidence_objective']:.4f} | {after['weak_evidence_objective']:.4f} |")
    lines += ["", f"Swept {len(trial_results)} parameter combinations. " +
              ("New weights passed both holdout checks." if accepted else "Default weights retained because the candidate did not pass all adoption checks."),
              "", "Selected weights: `" + json.dumps(asdict(chosen)) + "`.", "",
              "Collection outcomes: `" + json.dumps(report['collection_statuses']) + "`.", "",
              "Rows from each input: `" + json.dumps(report['source_counts']) + "`.", "",
              "Businesses sharing a phone number, website domain or social profile stay in one split.", "",
              "See [findings.csv](findings.csv) for every sampled row and [tuning-report.json](tuning-report.json) "
              "for both the proposed and selected weights, per-source results and limitations.", ""]
    (corpus_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    with (corpus_dir / "findings.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["source", "title", "website", "split", "collection_status", "pages", "baseline_email", "selected_email", "selected_type", "score", "evidence_supported", "seconds"])
        for item in items:
            r = item["record"]
            _, before = predict(item, default)
            score, after = predict(item, chosen)
            writer.writerow([r["source"], r["row"]["title"], r["row"]["website"], splits[r["id"]],
                             r["status"], r["pages_read"], before["email"] if before else "",
                             after["email"] if after else "", after["kind"] if after else "", score,
                             after["supported"] if after else "", r["seconds"]])
    if apply:
        artifact = {"version": 1, "weights": asdict(chosen), "calibration": {
            "seed": manifest["seed"], "rows": len(records), "accepted": accepted,
            "report": (corpus_dir.relative_to(PARAMETERS_PATH.parent.parent) / "tuning-report.json").as_posix()}}
        if PARAMETERS_PATH.exists():
            (corpus_dir / "parameters-before.json").write_bytes(PARAMETERS_PATH.read_bytes())
        temporary = PARAMETERS_PATH.with_suffix(".tmp")
        temporary.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        temporary.replace(PARAMETERS_PATH)
    print(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    calibrate(args.corpus.resolve(), args.apply)
