"""Reject local/network-internal destinations supplied by a sheet or remote page."""
from __future__ import annotations
import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit


async def public_url(url: str) -> bool:
    try:
        p = urlsplit(url)
        if p.scheme not in {"http", "https"} or not p.hostname or p.username or p.password:
            return False
        if p.port not in (None, 80, 443):
            return False
        host = p.hostname.lower().rstrip(".")
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
            return False
        try:
            return ipaddress.ip_address(host).is_global
        except ValueError:
            addresses = await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(host, p.port or 443, type=socket.SOCK_STREAM), 8,
            )
            return bool(addresses) and all(ipaddress.ip_address(a[4][0]).is_global for a in addresses)
    except (ValueError, OSError, asyncio.TimeoutError):
        return False


def form_host(url: str) -> bool:
    p = urlsplit(url)
    host = (p.hostname or "").lower()
    if host == "docs.google.com":
        return p.path.startswith("/forms/")
    return any(host == d or host.endswith("." + d) for d in (
        "forms.gle", "jotform.com", "typeform.com", "wufoo.com", "formstack.com",
        "cognitoforms.com", "forms.office.com", "hsforms.com", "tally.so",
    ))
