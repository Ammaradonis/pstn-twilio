"""A transient page failure must end one query, not the whole pass.

On 23 Oct the Meta ads worker died after a single 30-second read of a slow
ads-library page: `Locator.inner_text: Timeout 30000ms exceeded.` raised through
the scroll task, the task group went down with it, status.json said
"interrupted", and the process exited — with or without hours of evidence
behind it. Nothing restarted it, so the Dial page's Meta ad filter stayed empty.
"""
import asyncio
import unittest

from playwright.async_api import TimeoutError as PlaywrightTimeout

import run


class _Locator:
    def __init__(self, page):
        self.page = page

    async def inner_text(self, timeout=None):
        self.page.reads.append(timeout)
        outcome = self.page.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def count(self):
        return 0


class _Page:
    """Just the parts of a Playwright page the read and the query touch."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.reads = []
        self.url = 'https://www.facebook.com/ads/library/?country=US'

    def locator(self, selector):
        return _Locator(self)

    async def wait_for_timeout(self, milliseconds):
        return None

    async def goto(self, url, **kwargs):
        return None


def _pipeline(**search):
    """A Pipeline with only what query_reason uses."""
    pipeline = run.Pipeline.__new__(run.Pipeline)
    if search:
        pipeline.search = search['search']
    return pipeline


class BodyTextTest(unittest.TestCase):
    def test_a_slow_read_is_retried(self):
        page = _Page([PlaywrightTimeout('Timeout 15000ms exceeded.'), 'All ads'])
        self.assertEqual(asyncio.run(run.body_text(page)), 'All ads')
        self.assertEqual(len(page.reads), 2)

    def test_a_read_that_never_answers_gives_up(self):
        page = _Page([PlaywrightTimeout('x')] * 3)
        with self.assertRaises(PlaywrightTimeout):
            asyncio.run(run.body_text(page))
        self.assertEqual(len(page.reads), 3)


class QueryReasonTest(unittest.TestCase):
    def test_a_timeout_is_recorded_as_an_error_for_this_query_only(self):
        async def search(page, country, query, extractor):
            raise PlaywrightTimeout('Locator.inner_text: Timeout 30000ms exceeded.')

        reason, ads = asyncio.run(_pipeline(search=search).query_reason(None, 'US', 'karate', 'js'))
        # Not 'stalled' or 'no_results': a later run must revisit this query.
        self.assertEqual((reason, ads), ('error', 0))

    def test_a_finished_search_keeps_its_reason_and_count(self):
        async def search(page, country, query, extractor):
            return 'stalled', 42

        self.assertEqual(asyncio.run(_pipeline(search=search).query_reason(None, 'US', 'karate', 'js')),
                         ('stalled', 42))

    def test_a_page_that_needs_the_user_still_ends_the_pass(self):
        async def search(page, country, query, extractor):
            raise run.StopScrape('Facebook needs manual login or verification; collection stopped.')

        with self.assertRaises(run.StopScrape):
            asyncio.run(_pipeline(search=search).query_reason(None, 'US', 'karate', 'js'))

    def test_stop_scrape_is_a_runtime_error_so_the_status_carries_its_text(self):
        self.assertTrue(issubclass(run.StopScrape, RuntimeError))


if __name__ == '__main__':
    unittest.main()
