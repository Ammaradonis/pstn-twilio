import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import dns.exception
import dns.resolver
import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.cache import Cache
from email_finder.engine import Finding
from email_finder.extract import extract_math_challenge, parse_page
from email_finder.fetch import _fb_about_url
from email_finder.search import BraveSearch, SearchBudgetExhausted, SearchUnavailable
from email_finder.validate import DnsUnavailable, DomainChecker
from email_finder.worker import to_result
from email_finder.forms import answer_field
from email_finder.urls import public_url
from email_finder.sources import request_sources, directory_sites


def test_google_first_brave_alias_fallback_no_unverified_service(tmp_path):
    async def run():
        calls = []
        def handler(request):
            calls.append(request)
            if request.url.host == 'www.googleapis.com':
                return httpx.Response(403)
            assert request.url.host == 'api.search.brave.com'
            assert request.headers['X-Subscription-Token'] == 'fallback-secret'
            return httpx.Response(200, json={'web': {'results': [{'url': 'https://dojo.org', 'title': 'Dojo', 'description': 'Contact'}]}})
        search = BraveSearch('fallback-secret', Cache(tmp_path / 'c.db'), 10, 'fallback-secret', 10, 'google-secret', 'cx')
        await search._client.aclose()
        search._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        assert len(search.providers) == 2
        assert len(await search.search('dojo')) == 1
        assert len(await search.search('dojo')) == 1
        assert len(calls) == 2
        assert calls[0].url.host == 'www.googleapis.com'
        await search.close()
    asyncio.run(run())


def test_budget_reservations_include_failed_calls_and_are_atomic(tmp_path):
    async def run():
        cache = Cache(tmp_path / 'c.db')
        search = BraveSearch('key', cache, 1)
        await search._client.aclose()
        search._client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
        with pytest.raises(SearchUnavailable):
            await search.search('first')
        with pytest.raises(SearchBudgetExhausted):
            await search.search('second')
        assert cache.reserve('test', 1)
        assert not cache.reserve('test', 1)
        await search.close()
    asyncio.run(run())


@pytest.mark.parametrize('kind,expected', [('mx', True), ('null', False), ('nxdomain', False), ('ipv6', True), ('timeout', None)])
def test_real_dns_semantics(tmp_path, kind, expected):
    async def run():
        checker = DomainChecker(Cache(tmp_path / 'c.db'))
        async def resolve(domain, record):
            if kind == 'timeout':
                raise dns.exception.Timeout()
            if kind == 'nxdomain':
                raise dns.resolver.NXDOMAIN()
            if kind == 'ipv6':
                if record != 'AAAA':
                    raise dns.resolver.NoAnswer()
                return [object()]
            return [SimpleNamespace(exchange='.' if kind == 'null' else 'mx.dojo.org.')]
        checker._resolver.resolve = resolve
        if expected is None:
            with pytest.raises(DnsUnavailable):
                await checker.accepts_mail('gmail.com')  # Free providers are also validated.
            assert checker.cache.get('mx-v2', 'gmail.com') is None
        else:
            assert await checker.accepts_mail('dojo.org') is expected
        assert not checker._inflight
    asyncio.run(run())


def test_shared_dns_request_does_not_race_cleanup(tmp_path):
    async def run():
        checker = DomainChecker(Cache(tmp_path / 'c.db'))
        async def resolve(*args):
            await asyncio.sleep(0.01)
            return [SimpleNamespace(exchange='mail.dojo.org.')]
        checker._resolver.resolve = resolve
        assert await asyncio.gather(*[checker.accepts_mail('dojo.org') for _ in range(5)]) == [True] * 5
    asyncio.run(run())


def test_safe_math_and_facebook_numeric_ids():
    assert extract_math_challenge('What is 3 + 4?') == 7
    assert extract_math_challenge('Solve 3 / 2 to reveal email') is None
    assert extract_math_challenge('Solve 4 / 0') is None
    assert _fb_about_url('https://facebook.com/profile.php?id=12345') == 'https://www.facebook.com/profile.php?id=12345&sk=about_contact_and_basic_info'
    assert not parse_page('https://dojo.org', '<a href="https://evil.org/docs.google.com/forms/x">contact</a>').forms


def test_form_answers_use_sender_not_school_or_invented_student():
    sender = {'name': 'Alex Baker', 'email': 'alex@business.org', 'phone': '+12025550123'}
    assert answer_field('Your name', 'text', sender, 'Subject\n\nBody', 'Subject') == 'Alex Baker'
    assert answer_field('Message', 'textarea', sender, 'Subject\n\nBody', 'Subject') == 'Subject\n\nBody'
    for label in ('Student age', 'Child name', 'Medical conditions', 'Belt level', 'Preferred trial class'):
        assert answer_field(label, 'text', sender, 'body', 'subject') is None
    assert answer_field('Accept marketing', 'checkbox', sender, 'body', 'subject') is None


def test_deferred_result_retains_lease_and_research_state():
    result = to_result('row', Finding(retry_after=1800, research_complete=False), 'lease')
    assert result['status'] == 'RETRY'
    assert result['leaseToken'] == 'lease'
    assert result['retryAfter'] == 1800


def test_internal_urls_are_rejected():
    for url in ('http://127.0.0.1', 'http://169.254.169.254/latest', 'file:///secrets', 'http://[::1]', 'https://user:pass@school.org', 'http://localhost'):
        assert not asyncio.run(public_url(url))


def test_user_source_document_is_loaded_without_parsing_markdown_as_urls():
    assert {'ibjjf.com', 'worldtaekwondo.org', 'usadojo.com', 'usamartialartists.org'} <= set(request_sources())
    sites = directory_sites('GB', 'judo', 'Test Judo')
    assert 'britishjudo.org.uk' in sites and 'yell.com' in sites and 'kihapp.com' in sites
