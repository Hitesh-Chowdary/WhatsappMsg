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
        try:
            import fitz
            doc = fitz.open(file_path)
            for page in doc:
                text += page.get_text("text") + "\n"
        except Exception as e:
            logger.warning(f"fitz PDF extraction failed for {filename}: {e}")

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
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                text = f.read()
        except UnicodeDecodeError:
            with open(file_path, "r", encoding="latin-1") as f:
                text = f.read()
        except Exception as e:
            logger.error(f"Failed to read text file {filename}: {e}")

    text = text.replace("\x00", "")
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    return text

def clean_sentence_fragment(text: str) -> str:
    """Cleans up raw extracted text fragments into coherent English sentences."""
    if not text:
        return ""
    # Normalize internal newlines to single spaces
    clean = re.sub(r'[\r\n]+', ' ', text)
    clean = re.sub(r'\s+', ' ', clean).strip()

    # Remove noise prefixes & headers
    clean = re.sub(r'^(?:Skip to content|Public Self Disclosure|About The University|Built for Future|HOSTEL FACILITY|Location Map)\s*', '', clean, flags=re.IGNORECASE).strip()

    # Fix trailing commas or incomplete punctuation
    if clean.endswith(','):
        clean = clean[:-1] + '.'
    elif not clean.endswith(('.', '!', '?', ':')):
        clean = clean + '.'

    # Ensure initial capitalization
    if clean and clean[0].islower():
        clean = clean[0].upper() + clean[1:]

    return clean

async def query_brochures(
    query_text: str,
    active_brochures: List[Any],
    website_pages: Optional[List[Any]] = None,
    student_name: str = "Student",
    parent_name: str = "Parent",
    selected_branch: str = "Program"
) -> Optional[Dict[str, Any]]:
    """
    Searches active brochure documents & crawled website pages, generating a natural, well-formatted English answer.
    """
    all_docs = list(active_brochures or [])
    if website_pages:
        all_docs.extend(website_pages)

    if not all_docs:
        return None

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

Use ONLY the institutional brochure context below to provide a polite, natural, and well-structured answer in clear English.
Guidelines:
- Start with a direct, reassuring answer (e.g., "Yes, NRI University provides hostel accommodation for students.")
- Keep the response formatted cleanly for WhatsApp using bold text *like this* for key points.
- Ensure complete sentences with correct grammar. Do NOT output broken fragments or single word lines.
- Do not add any interactive buttons or "Ask Counselor" button text.

=== BROCHURE KNOWLEDGE BASE ===
{combined_knowledge[:8000]}
"""

            response = model.generate_content(prompt)
            if response and response.text:
                answer = response.text.strip()
                if not answer.startswith("===") and "Skip to content" not in answer:
                    return {
                        "reply_text": answer,
                        "source": "AI Brochure Engine (Gemini)",
                        "buttons": []
                    }
        except Exception as e:
            logger.warning(f"Gemini API query failed or disabled: {e}")

    # 2. Extractive Matching with Sentence Reconstruction & Natural English Formatting
    keywords = [w.lower().strip() for w in re.findall(r'\w+', query_text) if len(w) > 2]
    if not keywords:
        keywords = [query_text.lower().strip()]
    
    clean_matches = []
    for doc in all_docs:
        doc_text = getattr(doc, "extracted_text", "")
        doc_title = getattr(doc, "title", "") or getattr(doc, "filename", "") or ""
        doc_title_lower = doc_title.lower()

        if not doc_text and not doc_title:
            continue

        cleaned_doc_text = re.sub(r'(?i)skip to content\s*', '', doc_text or '')
        cleaned_doc_text = re.sub(r'(?i)public self disclosure\s*', '', cleaned_doc_text)
        cleaned_doc_text = re.sub(r'\s+', ' ', cleaned_doc_text)  # Normalize multiple spaces/newlines

        title_score = sum(5 for kw in keywords if kw in doc_title_lower)

        # Split text into clean individual sentences
        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', cleaned_doc_text) if len(s.strip()) > 15]

        for sentence in sentences:
            s_clean = clean_sentence_fragment(sentence)
            if len(s_clean) < 15 or len(s_clean) > 300:  # Ignore giant raw page dumps
                continue
            s_lower = s_clean.lower()
            match_score = title_score + sum(2 for kw in keywords if kw in s_lower)
            if match_score > 0:
                clean_matches.append((match_score, s_clean))

    if clean_matches:
        clean_matches.sort(key=lambda x: x[0], reverse=True)
        top_excerpts = []
        seen = set()
        for _, text in clean_matches:
            if text not in seen:
                seen.add(text)
                top_excerpts.append(text)
            if len(top_excerpts) >= 2:
                break
                
        # Smart intent-based introductory sentence
        query_lower = query_text.lower()
        if "hostel" in query_lower:
            intro = "NRI University provides safe, comfortable, and well-maintained hostel accommodation for students."
        elif "location" in query_lower or "address" in query_lower or "map" in query_lower or "where" in query_lower:
            intro = "NRI University (NRI Institute of Technology) is located at Pothavarappadu, Agiripalli Mandal, near Vijayawada, Andhra Pradesh."
        elif "fee" in query_lower or "cost" in query_lower or "fee structure" in query_lower:
            intro = f"Here are the fee details available in our official brochure for *{selected_branch}*:"
        else:
            intro = f"Here is information regarding *{query_text.strip()}*:"

        if top_excerpts:
            bullet_content = "\n\n• ".join(top_excerpts)
            reply_text = f"{intro}\n\n• {bullet_content}"
        else:
            reply_text = intro

        # Cap total reply text length to 400 characters max for clean WhatsApp display
        if len(reply_text) > 400:
            reply_text = reply_text[:397] + "..."

        return {
            "reply_text": reply_text,
            "source": "Document Knowledge Base",
            "buttons": []
        }

    # 0. Check for casual greetings / small talk first
    query_lower = query_text.lower().strip()
    greeting_words = ["hello", "hi", "hey", "hlo", "good morning", "good afternoon", "good evening", "namaste", "start", "menu", "greetings"]
    if any(query_lower == g or query_lower.startswith(g + " ") for g in greeting_words):
        return {
            "reply_text": f"Hello {student_name if student_name != 'N/A' else ''}! Welcome to *NRI University Admissions*. How can I assist you today? You can ask about our courses, fee structure, hostel facilities, or campus location.",
            "source": "AI Admissions Assistant",
            "buttons": ["Courses & Fees", "Hostel Facilities", "Contact Counselor"]
        }

    # Friendly conversational fallback if query didn't match specific brochure excerpts
    if "hostel" in query_lower:
        fallback_reply = "NRI University offers modern hostel accommodation with 24/7 security, dining, and Wi-Fi facilities for both boys and girls. Would you like an admissions counselor to call you with full hostel fee details?"
    elif "location" in query_lower or "where" in query_lower or "address" in query_lower or "map" in query_lower:
        fallback_reply = "NRI University (NRI Institute of Technology) is located at Pothavarappadu, Agiripalli Mandal, near Vijayawada, Andhra Pradesh. College buses are available across Vijayawada and nearby areas."
    elif "fee" in query_lower or "cost" in query_lower or "price" in query_lower:
        fallback_reply = f"Our admissions team can provide the complete fee structure for *{selected_branch}*. Would you like a counselor to assist you directly?"
    else:
        fallback_reply = "Thank you for reaching out to *NRI University Admissions*! Our counselors can provide full details regarding your inquiry. Would you like an outreach counselor to contact you?"

    return {
        "reply_text": fallback_reply,
        "source": "AI Admissions Assistant",
        "buttons": ["Contact Counselor"]
    }
