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


def test_brave_keys_serve_the_chain_and_only_brave_is_contacted(tmp_path):
    async def run():
        calls = []
        def handler(request):
            calls.append(request)
            # The Custom Search JSON API is gone: no other host is ever called.
            assert request.url.host == 'api.search.brave.com'
            assert request.headers['X-Subscription-Token'] == 'beave-key'
            return httpx.Response(200, json={'web': {'results': [{'url': 'https://dojo.org', 'title': 'Dojo', 'description': 'Contact'}]}})
        search = BraveSearch('fallback-secret', Cache(tmp_path / 'c.db'), 10, 'beave-key', 10)
        await search._client.aclose()
        search._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        assert [p for p, _, _ in search.providers] == ['brave', 'brave']
        assert len(await search.search('dojo')) == 1
        assert len(await search.search('dojo')) == 1  # cached: no second request
        assert len(calls) == 1
        assert calls[0].url.host == 'api.search.brave.com'
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


def test_social_footer_links_are_not_school_profiles():
    urls = ["https://www.facebook.com/policy.php", "https://www.facebook.com/privacy/",
            "https://www.instagram.com/accounts/login/", "https://www.instagram.com/legal/terms/",
            "https://www.facebook.com/123456789/", "https://www.instagram.com/dojo/"]
    info = parse_page("https://dojo.org", "".join(f'<a href="{url}">link</a>' for url in urls))
    assert info.social == set(urls[-2:])


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


def test_unparseable_links_are_skipped_not_fatal():
    html = ('<a href="http://[simpay%20id=7651]/">pay</a><a href="http://[::1">x</a>'
            '<iframe src="http://[bad"></iframe><a href="/contact">Contact</a>')
    info = parse_page('https://dojo.org/', html)
    assert [link for link, _ in info.links] == ['https://dojo.org/contact']


def test_spaced_role_phrase_finds_its_weight():
    from email_finder import nlp
    found = nlp.people('Our school is run by Mark Davis, co - founder of the club since 1998.')
    assert any(p.name == 'Mark Davis' and p.weight == 1.0 for p in found)


def test_search_outage_explains_why(tmp_path):
    async def run():
        search = BraveSearch('key', Cache(tmp_path / 'c.db'), 10)
        await search._client.aclose()
        search._client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda r: httpx.Response(402, json={'error': {'code': 'CREDIT_EXHAUSTED'}})))
        with pytest.raises(SearchUnavailable, match='Brave credit exhausted'):
            await search.search('dojo')
        await search.close()
    asyncio.run(run())


def test_search_outage_still_delivers_site_email():
    from email_finder.engine import _Job, _Scored
    job = _Job.__new__(_Job)
    job.finding = Finding(retry_after=7200, research_complete=False)
    job.forms = []
    async def no_people():
        return []
    job._people = no_people
    best = _Scored.__new__(_Scored)
    best.email, best.kind, best.score, best.url, best.person = 'info@dojo.org', 'business', 70, 'https://dojo.org', None
    asyncio.run(job._finish(best))
    result = to_result('r1', job.finding, '00000000-0000-4000-8000-000000000000')
    assert result['status'] == 'FOUND' and result['researchComplete'] is False and 'retryAfter' not in result


def test_cache_compresses_pages_and_drops_stale_entries(tmp_path):
    import time as _time
    cache = Cache(tmp_path / 'c.db')
    page = {'html': '<p>dojo</p>' * 1000}
    cache.set('page-v2', 'a', page, 3600)
    stored = cache._db.execute("select v from kv where k='a'").fetchone()[0]
    assert isinstance(stored, bytes) and len(stored) < 1000
    assert cache.get('page-v2', 'a') == page
    cache.set('search-v2', 'small', [1], 3600)
    assert cache.get('search-v2', 'small') == [1]
    cache._db.execute("insert into kv values ('page', 'old', '{}', ?)", (_time.time() + 3600,))
    cache._db.execute("insert into kv values ('page-v2', 'expired', '{}', ?)", (_time.time() - 1,))
    cache.set('outbox-v2', 'r1', {'kind': 'research'}, 3600)
    cache.maintain(vacuum=True)
    keys = {k for (k,) in cache._db.execute('select k from kv')}
    assert keys == {'a', 'small', 'r1'}


def test_every_numbered_brave_key_is_a_provider(tmp_path, monkeypatch):
    from email_finder import config
    for name in list(config.os.environ):
        if name.startswith(('BEAVE_API_KEY', 'BRAVE_API_KEY')):
            monkeypatch.delenv(name)
    monkeypatch.setenv('BEAVE_API_KEY', 'k1')
    monkeypatch.setenv('BEAVE_API_KEY3', 'k3')
    monkeypatch.setenv('BEAVE_API_KEY2', 'k2')
    monkeypatch.setenv('BRAVE_API_KEY', 'k1')
    settings = config.load_settings()
    assert settings.brave_keys == ('k1', 'k2', 'k3')
    search = BraveSearch.from_settings(settings, Cache(tmp_path / 'c.db'))
    assert [c for p, c, _ in search.providers if p == 'brave'] == ['k1', 'k2', 'k3']


def test_exhausted_brave_key_falls_through_to_the_next(tmp_path):
    async def run():
        used = []
        def handler(request):
            used.append(request.headers['X-Subscription-Token'])
            if request.headers['X-Subscription-Token'] == 'k1':
                return httpx.Response(402, json={'error': {'code': 'CREDIT_EXHAUSTED'}})
            return httpx.Response(200, json={'web': {'results': [{'url': 'https://dojo.org', 'title': 'Dojo', 'description': ''}]}})
        search = BraveSearch('k1', Cache(tmp_path / 'c.db'), 10, extra_brave_keys=('k2',))
        await search._client.aclose()
        search._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        assert len(await search.search('dojo one')) == 1
        assert len(await search.search('dojo two')) == 1
        assert used == ['k1', 'k2', 'k2']  # k1 is skipped after its 402
        await search.close()
    asyncio.run(run())


def test_no_website_fallback_collects_social_profiles():
    from email_finder.engine import _Job, Row
    from email_finder.search import Result
    job = _Job.__new__(_Job)
    job.row = Row(title='Nevada Shotokan Karate')
    job.town, job.street, job.social = 'Las Vegas', '', set()
    job.site_host = job.site_domain = None
    job.country, job.forms, job.candidates, job.pages = 'US', [], [], []
    async def query(q):
        return [Result(url='https://www.facebook.com/nevadashotokan?ref=x', title='', snippet='')]
    async def nothing(*args, **kwargs):
        return None
    job._query, job._use_results, job._decide = query, nothing, nothing
    asyncio.run(job._search_no_website_fallback())
    assert 'https://www.facebook.com/nevadashotokan' in job.social


def test_method_describes_page_spot_and_fetch_mode():
    from email_finder.engine import describe_method
    from email_finder.extract import Candidate
    own = {'dojo.com'}
    def m(source, url, where='', via=''):
        return describe_method(Candidate('a@dojo.com', source, url, '', where, via), 'www.dojo.com', own)
    assert m('mailto', 'https://www.dojo.com/', 'footer') == "Mailto link in the footer of the school's homepage"
    assert m('text', 'https://www.dojo.com/team/') == "Page text on the school's /team page"
    assert m('text', 'https://www.facebook.com/dojo/about_contact_and_basic_info', via='iphone') == \
        'Facebook contact info via iPhone emulation'
    assert m('text', 'https://www.instagram.com/dojo/', via='iphone') == 'Instagram bio text via iPhone emulation'
    assert m('directory', 'https://usmaf.org/schools/dojo') == 'Affiliation listing on usmaf.org'
    assert m('directory', 'https://www.yelp.com/biz/dojo') == 'Directory listing on yelp.com'
    assert m('snippet', 'https://www.yelp.com/biz/dojo') == 'Search result snippet from yelp.com'
    assert m('jsonld', 'https://other.org/contact', via='browser') == \
        "Structured data (JSON-LD) on other.org's /contact page (rendered in a browser)"


def test_footer_addresses_are_marked():
    html = ('<main><p>Write to coach@dojo.com</p></main>'
            '<div class="site-footer"><a href="mailto:info@dojo.com">info@dojo.com</a></div>')
    where = {c.email: c.where for c in parse_page('https://dojo.com/', html).candidates}
    assert where == {'coach@dojo.com': '', 'info@dojo.com': 'footer'}
