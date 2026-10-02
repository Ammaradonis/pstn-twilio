"""Real Chromium, intercepted fixtures only: never contacts a school or sends a live message."""
import asyncio
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.cache import Cache
from email_finder.fetch import Fetcher
from email_finder.forms import FormSender
import email_finder.forms as forms_module

TASK = {'url': 'https://school.test/contact', 'subject': 'A business follow-up', 'body': 'Here is the business proposal.',
        'sender': {'name': 'Alex Baker', 'email': 'alex@business.org', 'phone': '+12025550123'}}

@pytest.mark.parametrize('mode,status,expected_sends', [
    ('send', 'SENT', 1), ('dry', 'PREPARED', 0), ('cancel', 'MANUAL', 0),
    ('student', 'MANUAL', 0), ('captcha', 'MANUAL', 0), ('uncertain', 'MANUAL', 1),
])
def test_submission_flow(tmp_path, monkeypatch, mode, status, expected_sends):
    async def run():
        async def allow(url): return True
        monkeypatch.setattr(forms_module, 'public_url', allow)
        fetcher = Fetcher(Cache(tmp_path / 'cache.db'))
        sends, arms = [], []
        extra = '<label>Student age<input required type="number" name="age"></label>' if mode == 'student' else ''
        if mode == 'captcha':
            extra = '<div class="g-recaptcha">Verify you are a human</div>'
        html = '''<html><body><form id="contact"><label>Your name<input name="name" required></label>
          <label>Your email<input type="email" name="email" required></label>
          <label>Message<textarea name="message" required></textarea></label>''' + extra + '''
          <button type="submit">Send message</button></form><script>
          document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();
          const data=Object.fromEntries(new FormData(e.target));
          const response=await fetch('/submit',{method:'POST',body:JSON.stringify(data)});
          document.body.innerHTML=await response.text();};</script></body></html>'''
        async def guard(page):
            async def route(r):
                if r.request.method == 'POST':
                    sends.append(r.request.post_data_json)
                    await r.fulfill(status=200, content_type='text/html', body='Processing' if mode == 'uncertain' else 'Your message has been sent')
                else:
                    await r.fulfill(status=200, content_type='text/html', body=html)
            await page.route('**/*', route)
        fetcher.guard_page = guard
        async def arm():
            arms.append(1)
            return mode != 'cancel'
        try:
            result = await FormSender(fetcher).send(TASK, arm, dry_run=mode == 'dry')
            assert result.status == status, result.notes
            assert len(sends) == expected_sends
            if sends:
                assert sends[0]['message'] == TASK['subject'] + '\n\n' + TASK['body']
                assert sends[0]['email'] == TASK['sender']['email']
            if mode in ('student', 'captcha', 'dry'):
                assert not arms
        finally:
            await fetcher.close()
    asyncio.run(run())


def test_google_hosted_multistep_form(tmp_path, monkeypatch):
    async def run():
        async def allow(url): return True
        monkeypatch.setattr(forms_module, 'public_url', allow)
        fetcher = Fetcher(Cache(tmp_path / 'cache.db'))
        sends = []
        async def guard(page):
            async def route(r):
                url = r.request.url
                if r.request.method == 'POST':
                    sends.append(r.request.post_data_json)
                    await r.fulfill(status=200, content_type='text/html', body='Your response has been recorded')
                elif 'school.test' in url:
                    await r.fulfill(content_type='text/html', body='<a href="https://forms.gle/test">Contact our school</a>')
                elif 'forms.gle' in url:
                    # Playwright only routes the first URL in an HTTP redirect
                    # chain. A client navigation keeps this fixture intercepted.
                    # https://playwright.dev/python/docs/api/class-page#page-route
                    await r.fulfill(content_type='text/html', body='''<script>
                      location.replace('https://docs.google.com/forms/d/test/viewform');
                      </script>''')
                else:
                    await r.fulfill(content_type='text/html', body='''<html><body><form>
                      <div role="listitem"><h3 id="q1">Email</h3><input type="email" aria-labelledby="q1" required></div>
                      <div role="button" tabindex="0" onclick="next()">Next</div></form><script>
                      function next(){document.querySelector('form').innerHTML='<div role="listitem"><h3 id="q2">Your message</h3><textarea aria-labelledby="q2" required></textarea></div><div role="button" tabindex="0" onclick="send()">Submit</div>';}
                      async function send(){const message=document.querySelector('textarea').value;
                      const r=await fetch('/submit',{method:'POST',body:JSON.stringify({message})});document.body.innerHTML=await r.text();}
                      </script></body></html>''')
            await page.route('**/*', route)
        fetcher.guard_page = guard
        async def arm(): return True
        try:
            result = await FormSender(fetcher).send(TASK, arm)
            assert result.status == 'SENT', result.notes
            assert sends == [{'message': TASK['subject'] + '\n\n' + TASK['body']}]
        finally:
            await fetcher.close()
    asyncio.run(run())
