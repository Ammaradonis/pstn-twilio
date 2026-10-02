"""Validated runtime weights shared by production and offline calibration."""
from dataclasses import dataclass
import json
import logging
from pathlib import Path

PARAMETERS_PATH = Path(__file__).with_name("scoring-parameters.json")


@dataclass(frozen=True)
class ScoreWeights:
    decision_bonus: int = 25
    own_domain_bonus: int = 25
    free_mail_with_own_bonus: int = 4
    minimum_score: int = 50

    def __post_init__(self):
        bounds = {"decision_bonus": (0, 40), "own_domain_bonus": (0, 40),
                  "free_mail_with_own_bonus": (0, 12), "minimum_score": (50, 85)}
        for name, (low, high) in bounds.items():
            value = getattr(self, name)
            if type(value) is not int or not low <= value <= high:
                raise ValueError(f"Invalid scoring parameter: {name}")


def load_weights(path: Path = PARAMETERS_PATH) -> ScoreWeights:
    if not path.exists():
        return ScoreWeights()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("version") != 1:
            raise ValueError("Unsupported scoring version")
        return ScoreWeights(**data["weights"])
    except (OSError, ValueError, TypeError, KeyError):
        logging.getLogger(__name__).warning("Invalid scoring parameters; using safe defaults")
        return ScoreWeights()
