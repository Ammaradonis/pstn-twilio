import asyncio
import json
import os
import unittest
from unittest.mock import patch

import httpx

from remote import MAX_BATCH, batches, evidence_rows, observation, upload

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


def result(ad, verified=True, **overrides):
    base = {'lead': dict(LEAD), 'ad': dict(ad), 'nameMatch': True, 'urlMatch': True,
            'dateMatch': True, 'verified': verified, 'reason': 'verified' if verified else 'name_review'}
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

    def test_ended_ad_keeps_both_dates(self):
        row = observation(result(ENDED_AD))
        self.assertEqual(row['status'], 'INACTIVE')
        self.assertEqual((row['startedAt'], row['endedAt']), ('2024-08-27', '2026-10-15'))

    def test_unverified_and_incomplete_results_are_dropped(self):
        self.assertIsNone(observation(result(ACTIVE_AD, verified=False)))
        self.assertIsNone(observation(result({**ACTIVE_AD, 'adId': 'not-a-number'})))
        self.assertIsNone(observation(result({**ACTIVE_AD, 'status': 'Unknown'})))
        self.assertIsNone(observation(result(ACTIVE_AD, lead={**LEAD, 'facebookUrl': ''})))

    def test_rows_are_unique_per_tab_and_ad(self):
        rows = evidence_rows([result(ACTIVE_AD), result(ACTIVE_AD),
                              result({**ACTIVE_AD, 'adId': '55555555'})])
        self.assertEqual(len(rows), 2)

    def test_batches_never_exceed_the_api_limit(self):
        rows = [dict(ACTIVE_AD, adId=str(i)) for i in range(MAX_BATCH * 2 + 1)]
        self.assertEqual([len(chunk) for chunk in batches(rows)], [MAX_BATCH, MAX_BATCH, 1])


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


if __name__ == '__main__':
    unittest.main()
