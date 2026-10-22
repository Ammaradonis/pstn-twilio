import unittest
from pathlib import Path
from playwright.async_api import async_playwright


class ExtractionTest(unittest.IsolatedAsyncioTestCase):
    async def test_preserves_card_identity_and_ignores_navigation(self):
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            try:
                page = await browser.new_page()
                await page.set_content('''
                  <a href="https://facebook.com/123">Signed-in User</a>
                  <article><div>Active</div><div>Library ID: 111</div>
                    <div>Started running on Jan 1, 2026</div>
                    <div><a href="https://www.facebook.com/schoolA/">School A</a></div>
                    <div>Sponsored</div><p>An ad mentioning School B</p></article>
                  <article><div>Inactive</div><div>Library ID: 222</div>
                    <div>Jan 1, 2020 - Jan 31, 2020</div>
                    <div><a href="https://www.facebook.com/schoolB/">School B</a></div>
                    <div>Sponsored</div></article>
                ''')
                cards = await page.evaluate((Path(__file__).parent / 'extract.js').read_text(encoding='utf-8'))
                self.assertEqual([(c['adId'], c['name']) for c in cards], [('111', 'School A'), ('222', 'School B')])
                self.assertEqual(cards[1]['dateText'], 'Jan 1, 2020 - Jan 31, 2020')
            finally:
                await browser.close()
