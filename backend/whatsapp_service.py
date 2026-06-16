import abc
import asyncio
import uuid
import logging
from typing import Dict, Any, Optional

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whatsapp_service")

class WhatsAppClient(abc.ABC):
    """
    Abstract interface for the WhatsApp API Client.
    Allows easy swapping between mock and production gateways.
    """
    
    @abc.abstractmethod
    async def send_message(
        self, 
        to_phone: str, 
        message_body: str,
        media_type: str = "none",
        media_url: str = None,
        template_variables: Dict[str, str] = None,
        template_name: str = None,
        template_language: str = None,
        variable_names: list = None
    ) -> Dict[str, Any]:
        """
        Send a WhatsApp template message (with optional media attachment) to a parent.
        
        Args:
            to_phone: Recipient's phone number
            message_body: Customized message body to send
            media_type: 'none', 'image', or 'document'
            media_url: The URL to the hosted image/document
            template_variables: Optional key-value variables for WhatsApp Cloud API templates
            
        Returns:
            Dict containing sending status and message_id if successful.
            """
        pass


class MockWhatsAppClient(WhatsAppClient):
    """
    Mock implementation of WhatsAppClient for development and local testing.
    Simulates sending messages and generates dummy tracking message IDs.
    """
    
    async def send_message(
        self, 
        to_phone: str, 
        message_body: str,
        media_type: str = "none",
        media_url: str = None,
        template_variables: Dict[str, str] = None,
        template_name: str = None,
        template_language: str = None,
        variable_names: list = None
    ) -> Dict[str, Any]:
        # Simulate slight network delay
        await asyncio.sleep(0.05)
        
        # Generate a unique tracking message ID
        message_id = f"wa_msg_{uuid.uuid4().hex[:12]}"
        
        # Log the mock dispatch
        if media_type != "none" and media_url:
            logger.info(
                f"MOCK DISPATCH [MEDIA: {media_type.upper()}] -> To: {to_phone} | Message ID: {message_id} | URL: {media_url} | Content: {message_body}"
            )
        else:
            logger.info(
                f"MOCK DISPATCH -> To: {to_phone} | Message ID: {message_id} | Content: {message_body} | Variables: {template_variables}"
            )
        
        return {
            "status": "success",
            "message_id": message_id,
            "gateway": "MockWhatsAppGateway",
            "sent_at": uuid.uuid4().hex[:8]  # dummy payload details
        }


class MetaWhatsAppClient(WhatsAppClient):
    """
    Production implementation of WhatsAppClient for Meta Cloud API.
    Sends template outreach messages using Meta's official Graph API.
    """
    
    def __init__(self):
        import os
        self.access_token = os.getenv("META_ACCESS_TOKEN")
        self.phone_number_id = os.getenv("META_PHONE_NUMBER_ID")
        self.template_name = os.getenv("META_TEMPLATE_NAME", "admission_outreach")
        self.template_language = os.getenv("META_TEMPLATE_LANGUAGE", "en_US")
        
    async def send_message(
        self, 
        to_phone: str, 
        message_body: str,
        media_type: str = "none",
        media_url: str = None,
        template_variables: Dict[str, str] = None,
        template_name: str = None,
        template_language: str = None,
        variable_names: list = None
    ) -> Dict[str, Any]:
        import os
        import httpx
        
        if not self.access_token or not self.phone_number_id:
            logger.error("Meta WhatsApp credentials missing in environment.")
            return {"status": "error", "message": "Meta credentials missing."}

        # Normalize phone number (strip '+' if present, Meta expects only digits)
        clean_phone = to_phone.strip().replace("+", "")
        if clean_phone.startswith("00"):
            clean_phone = clean_phone[2:]
            
        url = f"https://graph.facebook.com/v25.0/{self.phone_number_id}/messages"
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json"
        }
        
        # Use dynamic template configuration if supplied, else fall back to env variables
        active_template_name = template_name or self.template_name
        active_template_language = template_language or self.template_language
        
        # Explicit template language normalization for compatibility with Meta registered configurations
        if active_template_name == "admission_outreach" and active_template_language in ["en", "en-US", "en-GB"]:
            active_template_language = "en_US"
        elif active_template_name == "parent_outreach" and active_template_language in ["en_US", "en-US", "en-GB"]:
            active_template_language = "en"
        
        # Build components parameter array
        parameters = []
        vars_list = variable_names or []
        
        # If variable names list is empty, try to fetch/parse it from the DB
        if not vars_list:
            try:
                from database import AsyncSessionLocal, CampaignTemplate
                from sqlalchemy import select
                async with AsyncSessionLocal() as session:
                    stmt = select(CampaignTemplate).where(CampaignTemplate.template_name == active_template_name)
                    res = await session.execute(stmt)
                    t_obj = res.scalar_one_or_none()
                    if t_obj:
                        if t_obj.variable_names:
                            vars_list = [v.strip() for v in t_obj.variable_names.split(",") if v.strip()]
                        elif t_obj.template_text:
                            import re
                            parsed_vars = re.findall(r"\{\{([^}]+)\}\}", t_obj.template_text)
                            vars_list = [v.strip() for v in parsed_vars if v.strip()]
            except Exception as db_err:
                logger.error(f"Error fetching template variables from DB: {db_err}")

        # If still empty, fall back to environment variable
        if not vars_list:
            var_names_str = os.getenv("META_TEMPLATE_VARIABLE_NAMES")
            if var_names_str:
                vars_list = [v.strip() for v in var_names_str.split(",") if v.strip()]

        # Determine if template uses positional (e.g. {{1}}, {{2}}) or named variables
        if vars_list:
            is_positional = all(v.isdigit() for v in vars_list)
            
            # Resolve values for each variable in vars_list
            resolved_values = {}
            for var_name in vars_list:
                val = None
                if template_variables:
                    # 1. Direct match
                    val = template_variables.get(var_name)
                    if val is None:
                        # 2. Case-insensitive, space/underscore ignored match
                        norm_var = var_name.lower().replace("_", "").replace(" ", "")
                        for k, v in template_variables.items():
                            norm_k = str(k).lower().replace("_", "").replace(" ", "")
                            if norm_k == norm_var:
                                val = v
                                break
                    if val is None:
                        # 3. Synonym mapping fallbacks
                        norm_var = var_name.lower().replace("_", "").replace(" ", "")
                        if norm_var in ["studentname", "student", "candidatename", "candidate"]:
                            val = template_variables.get("student_name") or template_variables.get("student")
                        elif norm_var in ["parentname", "parent", "fathername", "mothername", "guardianname", "guardian"]:
                            val = template_variables.get("parent_name") or template_variables.get("parent")
                        elif norm_var in ["selectedbranch", "branch", "course", "selectedcourse", "status", "admissionstatus"]:
                            val = template_variables.get("selected_branch") or template_variables.get("branch") or template_variables.get("status")
                
                # If still None, check positional indices or fall back to default string
                if val is None:
                    if is_positional and var_name.isdigit():
                        idx = int(var_name)
                        if idx == 1:
                            val = template_variables.get("parent_name") or template_variables.get("parent") or template_variables.get("student_name") or template_variables.get("student") or "Parent"
                        elif idx == 2:
                            val = template_variables.get("student_name") or template_variables.get("student") or template_variables.get("selected_branch") or template_variables.get("branch") or "Student"
                        elif idx == 3:
                            val = template_variables.get("selected_branch") or template_variables.get("branch") or "Selected"
                        else:
                            val = ""
                    else:
                        norm_var = var_name.lower().replace("_", "").replace(" ", "")
                        if "student" in norm_var:
                            val = "Student"
                        elif "parent" in norm_var:
                            val = "Parent"
                        else:
                            val = "Selected"
                            
                resolved_values[var_name] = str(val)

            # Build components parameters array
            if is_positional:
                # Meta positional parameters must be sorted in index order: 1, 2, 3...
                sorted_keys = sorted(vars_list, key=lambda x: int(x) if x.isdigit() else 999)
                for k in sorted_keys:
                    parameters.append({
                        "type": "text",
                        "text": resolved_values[k]
                    })
            else:
                # Named parameters require "parameter_name" key
                for var_name in vars_list:
                    parameters.append({
                        "type": "text",
                        "parameter_name": var_name,
                        "text": resolved_values[var_name]
                    })

        components = []
        body_component = {
            "type": "body",
            "parameters": parameters
        }
        # Only append body component if there are parameters, or if parameters is empty, we can still append body with empty parameters.
        # Actually, if parameters is empty, it is safer to still append the body component but with empty parameters,
        # or omit the body component completely. In Meta, for templates with 0 parameters, the API is fine with either omitting
        # or passing parameters: []. Passing parameters: [] is safer in many SDKs, but let's see.
        # Let's check: details: "body: number of localizable_params (3) does not match the expected number of params (0)"
        # This error happened because we sent 3 parameters. If we send 0 parameters, Meta will match it perfectly.
        # Let's keep body_component in components.
        components.append(body_component)

        # Handle header media attachments if any
        if media_type != "none" and media_url:
            header_param = {}
            if media_type == "image":
                header_param = {
                    "type": "image",
                    "image": {
                        "link": media_url
                    }
                }
            elif media_type == "document":
                filename = media_url.split("/")[-1]
                header_param = {
                    "type": "document",
                    "document": {
                        "link": media_url,
                        "filename": filename
                    }
                }
            
            if header_param:
                components.append({
                    "type": "header",
                    "parameters": [header_param]
                })

        payload = {
            "messaging_product": "whatsapp",
            "to": clean_phone,
            "type": "template",
            "template": {
                "name": active_template_name,
                "language": {
                    "code": active_template_language
                },
                "components": components
            }
        }
        
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                logger.info(f"Dispatching Meta template outreach to {clean_phone}...")
                res = await client.post(url, json=payload, headers=headers)
                
                if res.status_code == 200:
                    res_data = res.json()
                    messages = res_data.get("messages", [])
                    message_id = messages[0].get("id") if messages else f"meta_{uuid.uuid4().hex[:12]}"
                    logger.info(f"Meta dispatch SUCCESS. Message ID: {message_id}")
                    return {
                        "status": "success",
                        "message_id": message_id,
                        "gateway": "MetaCloudGateway"
                    }
                else:
                    logger.error(f"Meta Cloud API error response: {res.status_code} - {res.text}")
                    return {
                        "status": "error",
                        "code": res.status_code,
                        "message": res.text
                    }
        except Exception as e:
            logger.error(f"Meta request exception occurred: {e}")
            return {
                "status": "error",
                "message": str(e)
            }


def get_whatsapp_client(client_type_override: Optional[str] = None) -> WhatsAppClient:
    """
    Factory function to retrieve the configured WhatsApp client interface.
    Default type is 'mock'. Can be extended to support 'twilio', 'meta_cloud', etc.
    """
    import os
    if client_type_override:
        client_type = client_type_override.lower()
    else:
        client_type = os.getenv("WHATSAPP_CLIENT_TYPE", "mock").lower()
    
    if client_type == "mock":
        return MockWhatsAppClient()
    elif client_type in ["meta", "meta_cloud"]:
        return MetaWhatsAppClient()
    else:
        # Fallback to Mock if config is unknown
        logger.warning(f"Unknown WhatsApp client type '{client_type}'. Falling back to mock client.")
        return MockWhatsAppClient()
