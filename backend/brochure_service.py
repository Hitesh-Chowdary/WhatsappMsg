import os
import re
import logging
from typing import Optional, List, Dict, Any
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

def extract_text_from_file(file_path: str, filename: str) -> str:
    """Extracts raw text from uploaded PDF or text-based brochure document."""
    ext = os.path.splitext(filename)[1].lower()
    text = ""

    if ext == ".pdf":
        # 1. Try PyMuPDF (fitz)
        try:
            import fitz
            doc = fitz.open(file_path)
            for page in doc:
                text += page.get_text() + "\n"
        except Exception as e:
            logger.warning(f"fitz PDF extraction failed for {filename}: {e}")

        # 2. Fallback to pypdf if text is empty or fitz failed
        if not text.strip():
            try:
                import pypdf
                reader = pypdf.PdfReader(file_path)
                for page in reader.pages:
                    extracted = page.extract_text()
                    if extracted:
                        text += extracted + "\n"
            except Exception as e:
                logger.error(f"pypdf extraction failed for {filename}: {e}")
    else:
        # Text/Markdown/CSV files
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                text = f.read()
        except UnicodeDecodeError:
            with open(file_path, "r", encoding="latin-1") as f:
                text = f.read()
        except Exception as e:
            logger.error(f"Failed to read text file {filename}: {e}")

    # Clean whitespace
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    return text

async def query_brochures(
    query_text: str,
    active_brochures: List[Any],
    website_pages: Optional[List[Any]] = None,
    student_name: str = "Student",
    parent_name: str = "Parent",
    selected_branch: str = "Program"
) -> Optional[Dict[str, Any]]:
    """
    Searches active brochure documents & crawled website pages, generating an answer using Gemini API
    or smart contextual snippet matching.
    """
    all_docs = list(active_brochures or [])
    if website_pages:
        all_docs.extend(website_pages)

    if not all_docs:
        return None

    # Combine text from all active brochures & website pages
    combined_knowledge = ""
    for doc in all_docs:
        doc_text = getattr(doc, "extracted_text", "")
        doc_title = getattr(doc, "title", "Knowledge Resource")
        if doc_text and doc_text.strip():
            combined_knowledge += f"=== RESOURCE: {doc_title} ===\n{doc_text.strip()}\n\n"

    if not combined_knowledge.strip():
        return None

    gemini_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    
    # 1. Try LLM Generation via Gemini if key is provided
    if gemini_key:
        try:
            import google.generativeai as genai
            genai.configure(api_key=gemini_key)
            model = genai.GenerativeModel("gemini-1.5-flash")

            prompt = f"""You are an intelligent admissions & counseling assistant for an educational institution.
A candidate (Student: {student_name}, Parent: {parent_name}, Branch: {selected_branch}) asked the following question over WhatsApp:
"{query_text}"

Use ONLY the institutional brochure context below to provide a helpful, concise, and friendly answer. 
Guidelines:
- Keep the response formatted cleanly for WhatsApp (use bold text *like this* for key points).
- Do not make up information not supported by the document context.
- If the question cannot be answered from the document, politely state that you will notify an outreach counselor to provide complete details.

=== BROCHURE KNOWLEDGE BASE ===
{combined_knowledge[:8000]}
"""

            response = model.generate_content(prompt)
            if response and response.text:
                answer = response.text.strip()
                return {
                    "reply_text": answer,
                    "source": "AI Brochure Engine (Gemini)",
                    "buttons": ["Ask Counselor", "View Fee Structure"]
                }
        except Exception as e:
            logger.warning(f"Gemini API query failed, falling back to snippet matcher: {e}")

    # 2. Smart Extractive Snippet Matching Fallback
    keywords = [w.lower().strip() for w in re.findall(r'\w+', query_text) if len(w) > 3]
    paragraphs = [p.strip() for p in combined_knowledge.split("\n\n") if len(p.strip()) > 30]

    matched_paragraphs = []
    for p in paragraphs:
        p_lower = p.lower()
        score = sum(1 for kw in keywords if kw in p_lower)
        if score > 0:
            matched_paragraphs.append((score, p))

    matched_paragraphs.sort(key=lambda x: x[0], reverse=True)

    if matched_paragraphs:
        top_excerpts = [p for _, p in matched_paragraphs[:2]]
        clean_excerpt = "\n\n".join(top_excerpts)
        if len(clean_excerpt) > 600:
            clean_excerpt = clean_excerpt[:600] + "..."

        reply_text = (
            f"Here is what our official brochure mentions regarding your query:\n\n"
            f"{clean_excerpt}\n\n"
            f"If you need further details or personalized assistance, feel free to ask!"
        )
        return {
            "reply_text": reply_text,
            "source": "AI Brochure Engine (Extractive)",
            "buttons": ["Ask Counselor"]
        }

    return None
