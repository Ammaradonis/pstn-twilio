"""Is this a real, deliverable-looking address? Syntax + the domain's mail servers.

No mailbox probing: a domain with MX records (or, per RFC 5321, an A record
when MX is absent) can receive mail; NXDOMAIN or a null MX means it can't.
"""

from __future__ import annotations

import asyncio
import re

import dns.asyncresolver
import dns.exception
import dns.resolver
from email_validator import EmailNotValidError, validate_email

from .cache import Cache

NOISE = re.compile(
    r"(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse@|sentry|wixpress|"
    r"@sentry|wordpress\.(com|org)|@example\.|@domain\.|@email\.com$|@yourdomain|@yoursite|@company\.|"
    r"@test\.|@sample\.|@mysite\.|@website\.|@godaddy\.com|@squarespace\.com|@wix\.com|@weebly\.com|"
    r"@shopify\.com|@mailchimp|@sendgrid|@hubspot|@cloudflare|@google\.com|@facebook\.com|@instagram\.com|"
    r"@yelp\.com|@yell\.com|@tapology\.com|@smoothcomp\.com|@sentry\.io|@[a-z0-9-]+\.local$)",
    re.I,
)
# Mailboxes that never belong to a school's decision maker or front desk.
NEVER_LOCALS = re.compile(
    r"^(copyright|dmca|legal|privacy|gdpr|dpo|compliance|abuse|security|outboundsales|partners?|"
    r"affiliates?|advertising|ads|press|media|newsroom|investor|ir|unsubscribe|bounce|notifications?)"
    r"([._-]|$)"
)
PLACEHOLDER_LOCALS = {
    "email", "youremail", "your-email", "yourname", "your.name", "name", "firstname", "lastname",
    "first.last", "firstname.lastname", "user", "username", "test", "sample", "demo", "example",
    "someone", "john.doe", "jane.doe", "johndoe", "janedoe", "you", "me",
}
DNS_TTL = 7 * 24 * 3600


class DnsUnavailable(Exception):
    """Transient DNS failure: an address has NOT been validated."""


def plausible(email: str) -> bool:
    local, _, domain = email.partition("@")
    if not domain or NOISE.search(email) or local in PLACEHOLDER_LOCALS or NEVER_LOCALS.match(local):
        return False
    if len(local) > 40 or re.fullmatch(r"[a-f0-9]{16,}", local):  # tracking hashes
        return False
    try:
        validate_email(email, check_deliverability=False)
    except EmailNotValidError:
        return False
    return True


class DomainChecker:
    def __init__(self, cache: Cache) -> None:
        self.cache = cache
        self._resolver = dns.asyncresolver.Resolver()
        self._resolver.lifetime = 6.0
        self._inflight: dict[str, asyncio.Task[bool]] = {}

    async def accepts_mail(self, domain: str) -> bool:
        domain = domain.lower()
        cached = self.cache.get("mx-v2", domain)
        if cached is not None:
            return bool(cached)
        if domain not in self._inflight:
            self._inflight[domain] = asyncio.create_task(self._lookup(domain))
        task = self._inflight[domain]
        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                self._inflight.pop(domain, None)

    async def _lookup(self, domain: str) -> bool:
        ok = False
        try:
            answer = await self._resolver.resolve(domain, "MX")
            hosts = [str(r.exchange).rstrip(".") for r in answer]
            ok = any(h for h in hosts)  # a lone "." is a null MX: no mail
        except dns.resolver.NoAnswer:
            # RFC 5321 implicit MX, including IPv6-only mail hosts.
            for record in ("A", "AAAA"):
                try:
                    await self._resolver.resolve(domain, record)
                    ok = True
                    break
                except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
                    continue
                except dns.exception.DNSException as err:
                    raise DnsUnavailable("Mail-domain DNS lookup temporarily unavailable") from err
        except dns.resolver.NXDOMAIN:
            ok = False
        except dns.exception.DNSException as err:
            raise DnsUnavailable("Mail-domain DNS lookup temporarily unavailable") from err
        self.cache.set("mx-v2", domain, ok, DNS_TTL if ok else 3600)
        return ok
