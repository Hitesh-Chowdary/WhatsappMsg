import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from database import WebsiteKnowledge, Record
from crawler_service import clean_extracted_text, extract_domain_links

@pytest.mark.asyncio
async def test_crawler_helpers():
    """Test text cleaning and link extraction functions."""
    html_content = """
    <html>
      <head><title>Test University Admissions</title></head>
      <body>
        <nav><a href="/home">Home</a></nav>
        <main>
          <h1>Admissions 2026</h1>
          <p>Tuition fees for Computer Science engineering program is $8,000 per year.</p>
          <a href="/fees">View Fee Details</a>
          <a href="https://external.com/link">External Link</a>
        </main>
        <footer>Contact us</footer>
      </body>
    </html>
    """
    title, text = clean_extracted_text(html_content)
    assert title == "Test University Admissions"
    assert "Tuition fees for Computer Science" in text
    assert "Home" not in text  # nav removed
    assert "Contact us" not in text  # footer removed

    links = extract_domain_links(html_content, "https://testuniv.edu", "testuniv.edu")
    assert "https://testuniv.edu/fees" in links
    assert "https://external.com/link" not in links

@pytest.mark.asyncio
async def test_website_pages_crud(test_client: AsyncClient, auth_headers: dict, db_session: AsyncSession):
    """Test creating, listing, toggling, and deleting indexed website pages."""
    # 1. Insert a mock website page
    page = WebsiteKnowledge(
        url="https://rvrnriuniversity.edu.in/admissions",
        domain="rvrnriuniversity.edu.in",
        title="Official Admission Guidelines",
        extracted_text="B.Tech admissions require 60% in PCM. Last date to submit online application form is July 31.",
        is_active=True
    )
    db_session.add(page)
    await db_session.commit()

    # 2. List pages
    res = await test_client.get("/api/v1/website/pages", headers=auth_headers)
    assert res.status_code == 200
    pages = res.json()
    assert len(pages) >= 1
    assert any(p["url"] == "https://rvrnriuniversity.edu.in/admissions" for p in pages)
    page_id = pages[0]["id"]

    # 3. Toggle active status
    t_res = await test_client.patch(f"/api/v1/website/pages/{page_id}/toggle", headers=auth_headers)
    assert t_res.status_code == 200
    assert t_res.json()["page"]["is_active"] is False

    # 4. Delete page
    d_res = await test_client.delete(f"/api/v1/website/pages/{page_id}", headers=auth_headers)
    assert d_res.status_code == 200
    assert d_res.json()["status"] == "success"
