import re
import os
import logging
import asyncio
from typing import List, Dict, Any, Set
from urllib.parse import urlparse, urljoin
import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5"
}

def clean_extracted_text(html_content: str) -> tuple[str, str]:
    """Parses HTML content, extracts page title and main text while stripping navigation noise."""
    soup = BeautifulSoup(html_content, "html.parser")

    # Extract Page Title
    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
    elif soup.find("h1"):
        title = soup.find("h1").get_text().strip()
    if not title:
        title = "Institutional Page"

    # Remove script, style, nav, header, footer, noscript elements
    for element in soup(["script", "style", "nav", "footer", "header", "noscript", "svg", "form"]):
        element.decompose()

    # Extract text from main content area if available, else body
    main_area = soup.find("main") or soup.find("article") or soup.find("body") or soup
    text = main_area.get_text(separator="\n")

    # Clean whitespace and repetitive blank lines
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    clean_text = "\n".join(lines)
    clean_text = re.sub(r'\n{3,}', '\n\n', clean_text)

    return title, clean_text

def extract_domain_links(html_content: str, base_url: str, target_domain: str) -> List[str]:
    """Finds all internal links on the page belonging to the same domain."""
    soup = BeautifulSoup(html_content, "html.parser")
    found_links = set()

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue

        full_url = urljoin(base_url, href)
        parsed = urlparse(full_url)

        # Ensure link belongs to the target domain and is HTTP/HTTPS
        if parsed.netloc.lower() == target_domain.lower() and parsed.scheme in ["http", "https"]:
            # Ignore file downloads / assets
            ext = os.path.splitext(parsed.path)[1].lower()
            if ext not in [".jpg", ".png", ".gif", ".jpeg", ".svg", ".zip", ".exe"]:
                # Strip fragments
                clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                if parsed.query:
                    clean_url += f"?{parsed.query}"
                found_links.add(clean_url)

    return list(found_links)

async def crawl_website(root_url: str, max_pages: int = 25) -> Dict[str, Any]:
    """
    Crawls internal pages of a website domain concurrently up to max_pages,
    extracting clean text for the AI Knowledge Base.
    """
    if not root_url.startswith(("http://", "https://")):
        root_url = "https://" + root_url

    parsed_root = urlparse(root_url)
    target_domain = parsed_root.netloc.lower()

    visited_urls: Set[str] = set()
    to_visit: List[str] = [root_url]
    crawled_pages: List[Dict[str, Any]] = []

    sem = asyncio.Semaphore(5)

    async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=10.0) as client:
        async def fetch_page(url: str):
            async with sem:
                try:
                    logger.info(f"Crawling website page: {url}")
                    res = await client.get(url)
                    if res.status_code == 200 and "text/html" in res.headers.get("content-type", ""):
                        title, clean_text = clean_extracted_text(res.text)
                        if len(clean_text) > 100:
                            links = extract_domain_links(res.text, url, target_domain)
                            return {
                                "url": url,
                                "domain": target_domain,
                                "title": title,
                                "text": clean_text,
                                "links": links
                            }
                except Exception as e:
                    logger.warning(f"Failed to crawl page {url}: {e}")
                return None

        # Process first page
        first_page = await fetch_page(root_url)
        visited_urls.add(root_url)
        if first_page:
            crawled_pages.append(first_page)
            for link in first_page.get("links", []):
                if link not in visited_urls and link not in to_visit:
                    to_visit.append(link)

        # Process remaining pages concurrently in batches
        while to_visit and len(crawled_pages) < max_pages:
            batch_size = min(max_pages - len(crawled_pages), 5)
            batch_urls = []
            while to_visit and len(batch_urls) < batch_size:
                u = to_visit.pop(0)
                if u not in visited_urls:
                    visited_urls.add(u)
                    batch_urls.append(u)

            if not batch_urls:
                break

            results = await asyncio.gather(*(fetch_page(u) for u in batch_urls))
            for res in results:
                if res and len(crawled_pages) < max_pages:
                    crawled_pages.append(res)
                    for link in res.get("links", []):
                        if link not in visited_urls and link not in to_visit:
                            to_visit.append(link)

    return {
        "status": "success",
        "domain": target_domain,
        "pages_crawled": len(crawled_pages),
        "pages": crawled_pages
    }
