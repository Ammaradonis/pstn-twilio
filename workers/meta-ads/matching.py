"""Conservative identity and date checks shared by the local pipeline."""
import re
import unicodedata
from datetime import date, datetime
from urllib.parse import urlsplit, parse_qs, unquote


def name_key(value):
    value = unicodedata.normalize('NFKC', value).casefold().replace('&', ' and ')
    return ' '.join(re.sub(r'[^\w\s]', ' ', value).split())


def facebook_key(value):
    try:
        u = urlsplit(value if '://' in value else 'https://' + value)
        if u.hostname not in {'facebook.com', 'www.facebook.com', 'm.facebook.com', 'mbasic.facebook.com'}:
            return ''
        parts = [unquote(p).casefold() for p in u.path.split('/') if p]
        if parts == ['profile.php']:
            ident = parse_qs(u.query).get('id', [''])[0]
            return 'id:' + ident if ident.isdigit() else ''
        if len(parts) == 3 and parts[0] in {'people', 'pages'} and parts[-1].isdigit():
            return 'id:' + parts[-1]
        if len(parts) == 1 and parts[0] not in {'ads', 'login', 'groups', 'watch', 'share', 'help', 'reel', 'photo.php', 'profile.php', 'home.php', 'settings', 'marketplace', 'events', 'gaming', 'l.php'}:
            return ('id:' if parts[0].isdigit() else 'name:') + parts[0]
    except ValueError:
        pass
    return ''


def ad_dates(ad):
    raw = ad['dateText'].split(' · ')[0]
    def parse(s):
        return datetime.strptime(s.strip(), '%b %d, %Y').date()
    try:
        if ad['status'] == 'Active' and raw.startswith('Started running on '):
            return parse(raw.removeprefix('Started running on ')), date.fromisoformat(ad['observedAt'][:10])
        if ad['status'] == 'Inactive' and ' - ' in raw:
            start, end = raw.split(' - ', 1)
            return parse(start), parse(end)
    except ValueError:
        pass
    return None


def qualifies(ad, start, end, include_active, all_time=False):
    if all_time:
        return ad['status'] in {'Active', 'Inactive'}
    if not start or not end:
        return False
    if ad['status'] == 'Active' and not include_active:
        return False
    dates = ad_dates(ad)
    return bool(dates and dates[0] <= end and dates[1] >= start)


def has_own_page(facebook_url):
    """True when the tab's own facebookUrl cell names a page."""
    return bool(facebook_key(facebook_url or ''))


def is_evidence(*, name_match, url_match, own_page, eligible):
    """Whether a pair may be uploaded as evidence for the Dial page's filter.

    Two identities count. The page one is strict: the tab's own facebookUrl cell
    and the ad's page are the same page. The name one covers the case most tabs
    are in - the sheet holds no page URL at all, so an exact normalized school
    name is the only handle there is, and the ad's page is copied into the filter
    tab so the reader can see where it ran. Blue backgrounds (--apply) are
    stricter and still require the page match.
    """
    named_only = bool(name_match and not own_page)
    return bool(eligible and (url_match or named_only))


def match_kind(url_match):
    """'page' when the page identity matched, 'name' when only the name did."""
    return 'page' if url_match else 'name'
