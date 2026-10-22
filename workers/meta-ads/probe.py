"""Read-only browser/session preflight; no workbook changes."""
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'workers/email-finder'))
from email_finder.cookies import import_once, FACEBOOK_HOSTS
from playwright.async_api import async_playwright


async def main():
    out = ROOT / '.cache/meta-ads'
    out.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(str(out / 'browser'), channel='msedge', headless=True, locale='en-US')
        try:
            await import_once(ctx, ROOT / 'www.facebook.com_cookies.txt', FACEBOOK_HOSTS, out / 'browser', '.cookies-imported')
            page = await ctx.new_page()
            url = 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&q=martial%20arts&search_type=keyword_unordered&media_type=all'
            await page.goto(url, wait_until='domcontentloaded', timeout=60000)
            await page.wait_for_timeout(8000)
            text = await page.locator('body').inner_text()
            (out / 'probe.txt').write_text(text, encoding='utf-8')
            cards = await page.evaluate((Path(__file__).parent / 'extract.js').read_text(encoding='utf-8'))
            (out / 'probe-links.json').write_text(json.dumps(cards, indent=2), encoding='utf-8')
            await page.screenshot(path=str(out / 'probe.png'))
            print(json.dumps({'url': page.url, 'count': len(cards), 'cards': [{k:v for k,v in c.items() if k != 'text'} for c in cards[:5]]}))
        finally:
            await ctx.close()

if __name__ == '__main__':
    asyncio.run(main())
