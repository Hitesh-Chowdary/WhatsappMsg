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
        
        # Build components parameter array
        parameters = []
        if variable_names is not None:
            vars_list = variable_names
        else:
            var_names_str = os.getenv("META_TEMPLATE_VARIABLE_NAMES")
            if var_names_str:
                vars_list = [v.strip() for v in var_names_str.split(",") if v.strip()]
            else:
                vars_list = []

        if template_variables:
            if vars_list:
                # Use named parameters based on the list
                for var_name in vars_list:
                    val = template_variables.get(var_name)
                    if val is None:
                        # Fallback mappings for common names
                        if "student" in var_name:
                            val = template_variables.get("student_name", "")
                        elif "parent" in var_name:
                            val = template_variables.get("parent_name", "")
                        elif "branch" in var_name or "status" in var_name:
                            val = template_variables.get("selected_branch", "")
                        else:
                            val = ""
                    parameters.append({
                        "type": "text",
                        "parameter_name": var_name,
                        "text": str(val)
                    })
            else:
                # Positional parameters: no parameter_name key
                for key in ["parent_name", "student_name", "selected_branch"]:
                    if key in template_variables:
                        parameters.append({
                            "type": "text",
                            "text": str(template_variables[key])
                        })
        else:
            # Fallback parsing from defaults
            if vars_list:
                for var_name in vars_list:
                    val = "Student" if "student" in var_name else ("Parent" if "parent" in var_name else "Selected")
                    parameters.append({
                        "type": "text",
                        "parameter_name": var_name,
                        "text": val
                    })
            else:
                parameters.append({
                    "type": "text",
                    "text": "Student"
                })
                parameters.append({
                    "type": "text",
                    "text": "Selected"
                })

        components = []
        body_component = {
            "type": "body",
            "parameters": parameters
        }
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
