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
                text += page.get_text("text") + "\n"
        except Exception as e:
            logger.warning(f"fitz PDF extraction failed for {filename}: {e}")

        # 2. Try pdfplumber if fitz produced empty or short text
        if len(text.strip()) < 20:
            try:
                import pdfplumber
                with pdfplumber.open(file_path) as pdf:
                    for page in pdf.pages:
                        page_text = page.extract_text()
                        if page_text:
                            text += page_text + "\n"
            except Exception as e:
                logger.warning(f"pdfplumber extraction failed for {filename}: {e}")

        # 3. Fallback to pypdf if text is still empty
        if len(text.strip()) < 20:
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

    # Remove null bytes & clean whitespace
    text = text.replace("\x00", "")
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
                # Ensure we don't return raw scraped resource text
                if not answer.startswith("===") and "Skip to content" not in answer:
                    return {
                        "reply_text": answer,
                        "source": "AI Brochure Engine (Gemini)",
                        "buttons": ["Ask Counselor", "View Fee Structure"]
                    }
        except Exception as e:
            logger.warning(f"Gemini API query failed or disabled: {e}")

    # Do not dump raw scraped website text on WhatsApp. Return None to trigger clean counselor handover.
    return None
