"""Prepare the dedicated research browser using locally supplied account credentials.

Default is headless. --interactive opens the dedicated browser for manual
login/checkpoints when the user explicitly runs this command. No credentials
are printed, exported, or passed in command-line arguments.
"""
import argparse
import asyncio
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.config import CACHE_DIR, REPO_ROOT, load_settings


def credentials(platform):
    prefix = platform.upper()
    username = os.environ.get(prefix + '_USERNAME') or os.environ.get(prefix + '_EMAIL')
    password = os.environ.get(prefix + '_PASSWORD')
    if username and password:
        return username, password
    # Support the user's notes format: Facebook: newline username, password.
    path = REPO_ROOT / 'env.txt'
    if not path.exists():
        return None
    lines = path.read_text(encoding='utf-8-sig').splitlines()
    for i, line in enumerate(lines[:-1]):
        if re.fullmatch(r'\s*' + platform + r'\s*:\s*', line, re.I):
            parts = lines[i + 1].split(',', 1)
            if len(parts) == 2 and all(p.strip() for p in parts):
                return tuple(p.strip() for p in parts)
    return None


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--interactive', action='store_true')
    args = parser.parse_args()
    from playwright.async_api import async_playwright
    settings = load_settings()
    profile = settings.chrome_profile_path or str(CACHE_DIR / 'browser-profile')
    if re.search(r'[\\/]User Data(?:[\\/]|$)', profile, re.I):
        print('Use a dedicated research profile; the main Chrome profile is unsupported.')
        return
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(profile, headless=not args.interactive, locale='en-GB')
        for platform, url, user_field, password_field, button in (
            ('Facebook', 'https://www.facebook.com/login/', 'input[name=email]', 'input[name=pass]', 'button[name=login]'),
            ('Instagram', 'https://www.instagram.com/accounts/login/', 'input[name=username]', 'input[name=password]', 'button[type=submit]'),
        ):
            page = await ctx.new_page()
            try:
                await page.goto(url, wait_until='domcontentloaded', timeout=25_000)
                await page.wait_for_timeout(1500)
                for label in ('Decline optional cookies', 'Only allow essential cookies'):
                    cookie_button = page.get_by_role('button', name=label, exact=True)
                    if await cookie_button.count():
                        await cookie_button.first.click(timeout=3000)
                creds = credentials(platform)
                if creds and await page.locator(user_field).count():
                    await page.locator(user_field).fill(creds[0])
                    await page.locator(password_field).fill(creds[1])
                    await page.locator(button).first.click(timeout=10_000)
                    await page.wait_for_timeout(4000)
                cookies = await ctx.cookies()
                authenticated = any(c['name'] == ('c_user' if platform == 'Facebook' else 'sessionid') and platform.lower() in c['domain'] for c in cookies)
                print(platform + ': ' + ('authenticated research session ready' if authenticated else 'manual login/checkpoint required'))
            except Exception:
                print(platform + ': session setup unavailable; manual login required')
            if not args.interactive:
                await page.close()
        if args.interactive:
            await asyncio.to_thread(input, 'Finish login in the dedicated browser, then press Enter here to save the session. ')
        await ctx.close()


if __name__ == '__main__':
    asyncio.run(main())
