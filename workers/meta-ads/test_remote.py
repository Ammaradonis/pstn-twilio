import asyncio
import json
import os
import unittest
from unittest.mock import patch

import httpx

from remote import MAX_BATCH, batches, by_tab, evidence_rows, observation, upload

LEAD = {
    'spreadsheetId': 'sheet-1',
    'sheetId': 7,
    'sheetTitle': 'Texas',
    'row': 12,
    'title': 'Austin Shotokan',
    'facebookUrl': 'https://www.facebook.com/austinshotokan',
}
ACTIVE_AD = {
    'adId': '1234567890',
    'name': 'Austin Shotokan',
    'facebookUrl': 'https://www.facebook.com/austinshotokan/?ref=ads',
    'status': 'Active',
    'dateText': 'Started running on Jan 5, 2026 · Platform: Facebook',
    'observedAt': '2026-10-23T09:00:00+00:00',
}
ENDED_AD = {
    'adId': '987654321',
    'name': 'Austin Shotokan',
    'facebookUrl': 'https://www.facebook.com/austinshotokan',
    'status': 'Inactive',
    'dateText': 'Aug 27, 2024 - Oct 15, 2026 · Platform: Facebook',
    'observedAt': '2026-10-23T09:00:00+00:00',
}


def result(ad, verified=True, evidence=None, **overrides):
    evidence = verified if evidence is None else evidence
    base = {'lead': dict(LEAD), 'ad': dict(ad), 'nameMatch': True, 'urlMatch': True,
            'dateMatch': True, 'verified': verified, 'evidence': evidence,
            'matchKind': 'page', 'reason': 'verified' if verified else 'name_review'}
    base.update(overrides)
    return base


class ObservationTest(unittest.TestCase):
    def test_running_ad_has_no_end_date(self):
        row = observation(result(ACTIVE_AD))
        self.assertEqual(row['status'], 'ACTIVE')
        self.assertEqual(row['startedAt'], '2026-01-05')
        self.assertIsNone(row['endedAt'])
        self.assertEqual(row['rowIndex'], 12)
        self.assertEqual(row['advertiserUrl'], ACTIVE_AD['facebookUrl'])
        self.assertEqual(row['matchKind'], 'page')

    def test_ended_ad_keeps_both_dates(self):
        row = observation(result(ENDED_AD))
        self.assertEqual(row['status'], 'INACTIVE')
        self.assertEqual((row['startedAt'], row['endedAt']), ('2024-08-27', '2026-10-15'))

    def test_a_tab_with_no_page_url_is_matched_by_exact_name(self):
        # 188 of the 209 candidates on 23 Oct were in this shape: the sheet has
        # no facebookUrl, so the exact school name is the only identity there is.
        row = observation(
            result(ACTIVE_AD, urlMatch=False, matchKind='name',
                   lead={**LEAD, 'facebookUrl': ''})
        )
        self.assertIsNotNone(row)
        self.assertEqual(row['matchKind'], 'name')
        # The advertiser's page goes in the field so an older API still accepts
        # the batch; matchKind is what says the match was by name.
        self.assertEqual(row['facebookUrl'], ACTIVE_AD['facebookUrl'])
        self.assertEqual(row['schoolTitle'], 'Austin Shotokan')

    def test_results_without_evidence_are_dropped(self):
        self.assertIsNone(observation(result(ACTIVE_AD, verified=False, evidence=False)))
        self.assertIsNone(observation(result({**ACTIVE_AD, 'adId': 'not-a-number'})))
        self.assertIsNone(observation(result({**ACTIVE_AD, 'status': 'Unknown'})))
        self.assertIsNone(observation(result({**ACTIVE_AD, 'facebookUrl': ''})))

    def test_rows_are_unique_per_tab_and_ad(self):
        rows = evidence_rows([result(ACTIVE_AD), result(ACTIVE_AD),
                              result({**ACTIVE_AD, 'adId': '55555555'})])
        self.assertEqual(len(rows), 2)

    def test_a_name_only_match_is_uploaded_even_when_it_is_not_blue(self):
        # verified=False (so no blue background) but evidence=True (so the tab
        # shows it): the two decisions are separate on purpose.
        rows = evidence_rows([
            result(ACTIVE_AD, verified=False, evidence=True, urlMatch=False, matchKind='name',
                   lead={**LEAD, 'facebookUrl': ''}),
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['matchKind'], 'name')

    def test_batches_never_exceed_the_api_limit(self):
        rows = [dict(ACTIVE_AD, adId=str(i)) for i in range(MAX_BATCH * 2 + 1)]
        self.assertEqual([len(chunk) for chunk in batches(rows)], [MAX_BATCH, MAX_BATCH, 1])

    def test_rows_are_posted_one_tab_at_a_time(self):
        rows = evidence_rows([
            result(ACTIVE_AD),
            result({**ACTIVE_AD, 'adId': '2222222222'},
                   lead={**LEAD, 'sheetId': 9, 'sheetTitle': 'Vermont'}),
            result({**ACTIVE_AD, 'adId': '3333333333'}),
        ])
        self.assertEqual([len(chunk) for chunk in by_tab(rows)], [2, 1])


class UploadTest(unittest.TestCase):
    def test_posts_batches_with_the_worker_token(self):
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            observations = json.loads(request.content)['observations']
            seen.append((request.url.path, request.headers['x-worker-token'], observations))
            return httpx.Response(200, json={'saved': len(observations), 'tabs': 1})

        rows = evidence_rows([result(ACTIVE_AD), result(ENDED_AD)])
        saved = asyncio.run(upload(rows, token='test-token', base='https://api.test',
                                   transport=httpx.MockTransport(handler)))
        self.assertEqual(saved['saved'], 2)
        self.assertEqual(len(seen), 1)
        path, token, observations = seen[0]
        self.assertEqual(path, '/api/meta-ads/worker/evidence')
        self.assertEqual(token, 'test-token')
        self.assertEqual(len(observations), 2)

    def test_missing_token_is_an_explained_failure(self):
        # remote.py loads the repo's .env, which holds the real token.
        with patch.dict(os.environ, {'EMAIL_FINDER_WORKER_TOKEN': ''}):
            with self.assertRaises(RuntimeError) as caught:
                asyncio.run(upload(evidence_rows([result(ACTIVE_AD)]), token=None, base='https://api.test',
                                   transport=httpx.MockTransport(lambda r: httpx.Response(200))))
        self.assertIn('EMAIL_FINDER_WORKER_TOKEN', str(caught.exception))

    def test_api_rejection_is_reported(self):
        transport = httpx.MockTransport(lambda r: httpx.Response(401, text='nope'))
        with self.assertRaises(RuntimeError) as caught:
            asyncio.run(upload(evidence_rows([result(ACTIVE_AD)]), token='t', base='https://api.test',
                               transport=transport))
        self.assertIn('401', str(caught.exception))

    def test_one_rejected_tab_does_not_lose_the_others(self):
        # The API validated Google sheet ids against a 2,000,000,000 ceiling;
        # Massachusetts is 2,079,617,744, and its batch used to be dropped
        # whole. One tab per request keeps that failure local.
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            observations = json.loads(request.content)['observations']
            seen.append([o['sheetTitle'] for o in observations])
            if any(o['sheetId'] > 2_000_000_000 for o in observations):
                return httpx.Response(400, json={'message': 'sheetId too large'})
            return httpx.Response(200, json={'saved': len(observations), 'tabs': 1})

        rows = evidence_rows([
            result(ACTIVE_AD),
            result({**ACTIVE_AD, 'adId': '2222222222'},
                   lead={**LEAD, 'sheetId': 2_079_617_744, 'sheetTitle': 'Massachusetts'}),
        ])
        with self.assertRaises(RuntimeError) as caught:
            asyncio.run(upload(rows, token='t', base='https://api.test',
                               transport=httpx.MockTransport(handler)))
        self.assertIn('1 tab(s), 1 row(s) saved', str(caught.exception))
        self.assertIn(['Texas'], seen)
        self.assertIn(['Massachusetts'], seen)

    def test_reports_how_many_tabs_were_stored(self):
        # The API answers tabs=1 for every one-tab request; the summary used to
        # take the max of those and said "1 tab" after storing 32.
        def handler(request: httpx.Request) -> httpx.Response:
            observations = json.loads(request.content)['observations']
            return httpx.Response(200, json={'saved': len(observations), 'tabs': 1})

        big = [result({**ACTIVE_AD, 'adId': str(10_000 + i)},
                      lead={**LEAD, 'sheetId': 9, 'sheetTitle': 'Vermont'})
               for i in range(MAX_BATCH + 1)]
        rows = evidence_rows([result(ACTIVE_AD), *big])
        saved = asyncio.run(upload(rows, token='t', base='https://api.test',
                                   transport=httpx.MockTransport(handler)))
        # Vermont takes two requests and still counts once.
        self.assertEqual(saved, {'saved': MAX_BATCH + 2, 'tabs': 2})


if __name__ == '__main__':
    unittest.main()
