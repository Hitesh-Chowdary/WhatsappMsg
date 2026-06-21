import asyncio
import io
import sys
import logging
from typing import Dict, Any

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("test_suite")

# Ensure required libraries are installed
try:
    import httpx
    import pandas as pd
except ImportError:
    logger.error("Required testing libraries missing. Please run: pip install httpx pandas openpyxl")
    sys.exit(1)

# Default Local API server URL (run 'uvicorn main:app --reload' on port 8000 first)
BASE_URL = "http://127.0.0.1:8001"

async def run_tests():
    logger.info("Initializing Admission Engine Integration Test Suite...")
    
    # 1. Generate Sample CSV Ingestion Payload
    csv_data = (
        "Student Name,Parent Name,Selected Branch,Phone Number\n"
        "Rajesh Kumar,Rohan Kumar,Computer Science,9876543210\n"
        "Priya Patel,Sanjay Patel,Information Technology,9812345678\n"
        "Amit Sharma,Vijay Sharma,Electronics,9900112233\n"
    )
    csv_bytes = csv_data.encode("utf-8")
    
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=10.0) as client:
        try:
            # Check server status / verify unauthorized access is blocked
            try:
                stats_check = await client.get("/api/v1/stats")
                assert stats_check.status_code == 401, f"Expected 401 Unauthorized for unauthenticated request, got {stats_check.status_code}"
                logger.info("Connection established. Verified unauthenticated requests are correctly rejected with 401 Unauthorized.")
            except httpx.ConnectError:
                logger.error(f"Cannot connect to server at {BASE_URL}. Ensure uvicorn server is running: 'uvicorn main:app --reload'")
                return

            # Test incoming WhatsApp webhook is public
            logger.info("Testing public access on webhook callback (/api/v1/whatsapp/webhook)...")
            webhook_payload = {
                "event": "status_update",
                "message_id": "wa_msg_nonexistent_test",
                "status": "delivered"
            }
            webhook_res = await client.post("/api/v1/whatsapp/webhook", json=webhook_payload)
            assert webhook_res.status_code == 200, f"Webhook failed: {webhook_res.text}"
            assert webhook_res.json()["status"] == "ignored", "Expected webhook to ignore fake message ID"
            logger.info("Confirmed: WhatsApp callback webhook is public.")

            # Test webhook verification GET endpoint
            logger.info("Testing WhatsApp GET Webhook Verification (/api/v1/whatsapp/webhook)...")
            verify_url = "/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.challenge=testchallenge&hub.verify_token=mytestingtoken"
            verify_res = await client.get(verify_url)
            assert verify_res.status_code == 200, f"Webhook GET verification failed: {verify_res.text}"
            assert verify_res.text == "testchallenge", f"Expected 'testchallenge' body, got: {verify_res.text}"
            logger.info("Confirmed: GET Webhook verification works.")

            # Authenticate admin user
            logger.info("Authenticating with default administrator credentials...")
            login_payload = {"username": "admin", "password": "admin123"}
            login_res = await client.post("/api/v1/auth/login", json=login_payload)
            assert login_res.status_code == 200, f"Login failed: {login_res.text}"
            auth_data = login_res.json()
            assert "access_token" in auth_data, "Auth token not returned"
            token = auth_data["access_token"]
            headers = {"Authorization": f"Bearer {token}", "X-WhatsApp-Client-Type": "mock"}
            logger.info("Authentication successful. Acquired JWT bearer token.")
            
            # Fetch a template by name since database defaults are now empty
            logger.info("Testing Fetch Template By Name endpoint (/api/v1/templates/add)...")
            add_tmpl_res = await client.post("/api/v1/templates/add", json={"template_name": "admission_outreach"}, headers=headers)
            assert add_tmpl_res.status_code == 200, f"Template addition failed: {add_tmpl_res.text}"
            logger.info("Successfully fetched and activated admission_outreach test template.")
            
            # 2. Test Ingestion File Upload API
            logger.info("Testing Excel Ingestion Parser endpoint (/api/v1/upload)...")
            files = {"file": ("test_admissions.csv", csv_bytes, "text/csv")}
            res = await client.post("/api/v1/upload", files=files, headers=headers)
            
            assert res.status_code == 200, f"Upload failed: {res.text}"
            upload_res = res.json()
            logger.info(f"Ingestion successful: {upload_res['message']}")
            assert upload_res["added"] == 3 or upload_res["updated"] == 3
            
            # 3. Test Paginated Records Listing
            logger.info("Testing Paginated Data Grid endpoint (/api/v1/records)...")
            res = await client.get("/api/v1/records?limit=10", headers=headers)
            assert res.status_code == 200, f"Records fetching failed: {res.text}"
            records_data = res.json()
            assert records_data["total"] >= 3, "Stored records count doesn't match uploaded count"
            
            # Grab one record for subsequent pipeline test steps
            test_record = next(r for r in records_data["records"] if r["phone_number"] in ["919876543210", "919812345678", "919900112233"])
            record_id = test_record["id"]
            phone = test_record["phone_number"]
            logger.info(f"Selected test target student: {test_record['student_name']} (Record ID: {record_id})")
            
            # Verify initial statuses
            assert test_record["campaign_status"] == "Pending", "Incorrect campaign status default"
            assert test_record["delivery_status"] == "Unsent", "Incorrect delivery status default"
            assert test_record["parent_response"] == "No Response", "Incorrect response status default"
            
            # 4. Test Single Dispatch campaign trigger
            logger.info(f"Testing Individual Campaign Dispatch (/api/v1/campaign/send-single/{record_id})...")
            res = await client.post(f"/api/v1/campaign/send-single/{record_id}", headers=headers)
            assert res.status_code == 200, f"Dispatch request failed: {res.text}"
            dispatch_res = res.json()
            logger.info(f"Dispatch status: {dispatch_res['message']}")
            
            # Confirm record status transitioned to sent
            res = await client.get("/api/v1/records", headers=headers)
            records_data = res.json()
            updated_record = next(r for r in records_data["records"] if r["id"] == record_id)
            assert updated_record["campaign_status"] == "Sent", "Campaign status did not transition to Sent"
            assert updated_record["delivery_status"] == "Sent", "Delivery status did not transition to Sent"
            assert updated_record["message_id"] is not None, "Message ID tracking key missing"
            message_id = updated_record["message_id"]
            logger.info(f"Captured tracking message ID: {message_id}")
            
            # Funnel Level 2 (Sent): Verify delivery_status=undelivered filter retrieves the record
            res = await client.get("/api/v1/records?delivery_status=undelivered", headers=headers)
            assert res.status_code == 200
            assert any(r["id"] == record_id for r in res.json()["records"]), "undelivered filter failed"
            logger.info("Funnel Level 2 (Sent/Undelivered) verified.")
            
            # Simulate Status Callback: Delivered
            logger.info("Simulating Webhook Status Callback: 'delivered' via public webhook...")
            webhook_payload = {
                "event": "status_update",
                "message_id": message_id,
                "status": "delivered"
            }
            res = await client.post("/api/v1/whatsapp/webhook", json=webhook_payload)
            assert res.status_code == 200, f"Webhook status update failed: {res.text}"
            
            # Funnel Level 2 (Delivered): Verify delivery_status=delivered filter retrieves the record
            res = await client.get("/api/v1/records?delivery_status=delivered", headers=headers)
            assert any(r["id"] == record_id for r in res.json()["records"]), "delivered filter failed"
            # Funnel Level 3 (Not Read): Verify delivery_status=not_read filter retrieves the record
            res = await client.get("/api/v1/records?delivery_status=not_read", headers=headers)
            assert any(r["id"] == record_id for r in res.json()["records"]), "not_read filter failed"
            # Funnel Level 3 (Read): Verify delivery_status=read filter does NOT retrieve the record yet
            res = await client.get("/api/v1/records?delivery_status=read", headers=headers)
            assert not any(r["id"] == record_id for r in res.json()["records"]), "read filter returned unread record"
            logger.info("Funnel Level 2 (Delivered) & Level 3 (Not Read) verified.")
            
            # 5. Test Webhook Status Callback (Simulate Status Callback: Read)
            logger.info(f"Simulating Webhook Status Callback: 'read' via public webhook...")
            webhook_payload = {
                "event": "status_update",
                "message_id": message_id,
                "status": "read"
            }
            res = await client.post("/api/v1/whatsapp/webhook", json=webhook_payload)
            assert res.status_code == 200, f"Webhook status update failed: {res.text}"
            
            # Verify record transitioned to Read and filter mapping matches
            res = await client.get("/api/v1/records?delivery_status=read", headers=headers)
            assert any(r["id"] == record_id for r in res.json()["records"]), "read filter failed"
            res = await client.get("/api/v1/records?delivery_status=not_read", headers=headers)
            assert not any(r["id"] == record_id for r in res.json()["records"]), "not_read filter returned read record"
            logger.info("Funnel Level 3 (Read) verified.")
            
            # 6. Test Webhook Quick Reply Callback (Simulate Parent Button Click: Interested)
            logger.info("Simulating Webhook Quick Reply button click: 'Interested' via public webhook...")
            webhook_payload = {
                "event": "quick_reply",
                "message_id": message_id,
                "button_text": "Interested"
            }
            res = await client.post("/api/v1/whatsapp/webhook", json=webhook_payload)
            assert res.status_code == 200, f"Webhook quick reply failed: {res.text}"
            
            # Verify response states
            res = await client.get("/api/v1/records?parent_response=Interested", headers=headers)
            assert any(r["id"] == record_id for r in res.json()["records"]), "Response filter failed"
            logger.info("Funnel Level 4 (Interested Response) verified.")
            
            # 6b. Test Webhook Status Callback (Simulate Status Callback: Failed)
            logger.info("Dispatching campaign to other record first to generate message_id...")
            other_record = next(r for r in records_data["records"] if r["id"] != record_id)
            other_id = other_record["id"]
            res = await client.post(f"/api/v1/campaign/send-single/{other_id}", headers=headers)
            assert res.status_code == 200
            
            # Fetch other record to capture message_id
            res = await client.get("/api/v1/records", headers=headers)
            records_data = res.json()
            updated_other = next(r for r in records_data["records"] if r["id"] == other_id)
            other_message_id = updated_other["message_id"]
            assert other_message_id is not None
            
            logger.info("Simulating Webhook Status Callback: 'failed' via public webhook...")
            webhook_payload = {
                "event": "status_update",
                "message_id": other_message_id,
                "status": "failed"
            }
            res = await client.post("/api/v1/whatsapp/webhook", json=webhook_payload)
            assert res.status_code == 200, f"Webhook failed: {res.text}"
            
            # Verify record transitioned to Failed
            res = await client.get("/api/v1/records", headers=headers)
            records_data = res.json()
            updated_record = next(r for r in records_data["records"] if r["id"] == other_id)
            assert updated_record["delivery_status"] == "Failed", "Delivery status did not transition to Failed"
            assert updated_record["campaign_status"] == "Failed", "Campaign status did not transition to Failed"
            
            # Verify filtered records query returns the failed record
            res = await client.get("/api/v1/records?delivery_status=Failed", headers=headers)
            assert res.status_code == 200, f"Filtering failed: {res.text}"
            filtered_data = res.json()
            assert any(r["id"] == other_id for r in filtered_data["records"]), "Failed filter did not return the failed record"
            logger.info("Confirmed: Filtering records by delivery_status=Failed functions correctly.")
            
            # 7. Test Aggregated stats metrics updates
            logger.info("Testing Statistics Counter aggregates (/api/v1/stats)...")
            res = await client.get("/api/v1/stats", headers=headers)
            assert res.status_code == 200, f"Stats fetching failed: {res.text}"
            stats = res.json()
            logger.info(f"Current stats: Total={stats['total']}, Sent={stats['sent']}, Read={stats['read']}, Failed={stats['failed']}, Interested={stats['interested']}, Not Interested={stats['not_interested']}")
            assert stats["interested"] >= 1, "Stats did not aggregate Interested count correctly"
            assert stats["failed"] >= 1, "Stats did not aggregate Failed count correctly"
            
            # 8. Test Filtered Excel Export
            logger.info("Testing Filtered Excel Export endpoint (/api/v1/records/export)...")
            # Unauthenticated export check
            res = await client.get("/api/v1/records/export")
            assert res.status_code == 401, "Unauthenticated export was not rejected with 401"
            logger.info("Confirmed: Unauthenticated export correctly rejected.")
            
            # Authenticated full export check
            res = await client.get("/api/v1/records/export", headers=headers)
            assert res.status_code == 200, f"Export failed: {res.text}"
            assert res.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Invalid content-type on export"
            
            # Read and verify Excel sheet content using pandas
            df_full = pd.read_excel(io.BytesIO(res.content))
            assert not df_full.empty, "Exported spreadsheet was empty"
            assert "Student Name" in df_full.columns, "Missing 'Student Name' column"
            assert "Delivery Status" in df_full.columns, "Missing 'Delivery Status' column"
            logger.info(f"Verified full export sheet structure. Total records exported: {len(df_full)}.")
            
            # Authenticated filtered export check (filter by Failed)
            res = await client.get("/api/v1/records/export?delivery_status=Failed", headers=headers)
            assert res.status_code == 200, f"Filtered export failed: {res.text}"
            df_filtered = pd.read_excel(io.BytesIO(res.content))
            assert not df_filtered.empty, "Filtered export spreadsheet was empty"
            assert all(df_filtered["Delivery Status"] == "Failed"), "Export contains records with delivery status other than Failed"
            logger.info(f"Verified filtered export content. Filtered records exported: {len(df_filtered)}.")

            # 9. Test Branches Fetching API
            logger.info("Testing Unique Branches Lookup endpoint (/api/v1/branches)...")
            res = await client.get("/api/v1/branches", headers=headers)
            assert res.status_code == 200, f"Branches fetch failed: {res.text}"
            branches_list = res.json()
            logger.info(f"Unique branches in DB: {branches_list}")
            assert "Computer Science" in branches_list, "Computer Science branch missing from lookup"
            assert "Information Technology" in branches_list, "Information Technology branch missing from lookup"
            assert "Electronics" in branches_list, "Electronics branch missing from lookup"
            
            # 10. Test Branch Filtering in Records API
            logger.info("Testing branch filtering in records query...")
            res = await client.get("/api/v1/records?branch=Computer Science", headers=headers)
            assert res.status_code == 200, f"Filtering by branch failed: {res.text}"
            cs_records = res.json()["records"]
            assert len(cs_records) > 0, "No records returned for Computer Science branch"
            assert all(r["selected_branch"] == "Computer Science" for r in cs_records), "Returned records with incorrect branch"
            logger.info(f"Branch filtering verified. Found {len(cs_records)} Computer Science records.")

            # 11. Test Branch Filtering in Export API
            logger.info("Testing branch filtering in Excel Export...")
            res = await client.get("/api/v1/records/export?branch=Computer Science", headers=headers)
            assert res.status_code == 200, f"Branch filtered export failed: {res.text}"
            df_branch = pd.read_excel(io.BytesIO(res.content))
            assert not df_branch.empty, "Branch filtered export spreadsheet was empty"
            assert all(df_branch["Selected Branch"] == "Computer Science"), "Export contains records with branches other than Computer Science"
            logger.info(f"Verified branch filtered export. Exported: {len(df_branch)} CS records.")

            # 12. Test Bulk Campaign Dispatch API
            logger.info("Testing Bulk Campaign Dispatch (/api/v1/campaign/send-bulk)...")
            res = await client.get("/api/v1/records", headers=headers)
            all_records = res.json()["records"]
            eligible_records = [r for r in all_records if r["parent_response"] != "Interested"]
            assert len(eligible_records) >= 2, "Need at least 2 eligible records to test bulk dispatch"
            
            bulk_target_ids = [r["id"] for r in eligible_records[:2]]
            logger.info(f"Triggering bulk dispatch for record IDs: {bulk_target_ids}")
            
            bulk_payload = {"record_ids": bulk_target_ids}
            res = await client.post("/api/v1/campaign/send-bulk", json=bulk_payload, headers=headers)
            assert res.status_code == 200, f"Bulk dispatch post failed: {res.text}"
            bulk_res = res.json()
            assert bulk_res["status"] == "success", f"Bulk dispatch failed status: {bulk_res}"
            logger.info(f"Bulk dispatch queued successfully: {bulk_res['message']}")
            
            # Wait for background task execution
            logger.info("Waiting for background bulk campaign execution...")
            for i in range(10):
                await asyncio.sleep(0.2)
                res = await client.get("/api/v1/records", headers=headers)
                updated_records = {r["id"]: r for r in res.json()["records"]}
                if all(updated_records[rid]["campaign_status"] == "Sent" for rid in bulk_target_ids):
                    logger.info("Bulk dispatch verified. Selected records transitioned to Sent status.")
                    break
            else:
                raise AssertionError("Bulk dispatch records did not transition to Sent within timeout")
                
            # 13. Test Bulk Campaign Outbox Safeguard (Skipping Interested Candidates)
            interested_rec = next((r for r in all_records if r["parent_response"] == "Interested"), None)
            if not interested_rec:
                logger.info("Simulating Interested parent for safeguard verification...")
                sim_target_id = eligible_records[0]["id"]
                target_rec = next(r for r in all_records if r["id"] == sim_target_id)
                target_msg_id = target_rec.get("message_id")
                if not target_msg_id:
                    await client.post(f"/api/v1/campaign/send-single/{sim_target_id}", headers=headers)
                    res = await client.get("/api/v1/records", headers=headers)
                    all_records = res.json()["records"]
                    target_rec = next(r for r in all_records if r["id"] == sim_target_id)
                    target_msg_id = target_rec["message_id"]
                webhook_payload = {
                    "event": "quick_reply",
                    "message_id": target_msg_id,
                    "button_text": "Interested"
                }
                await client.post("/api/v1/whatsapp/webhook", json=webhook_payload)
                interested_rec = {"id": sim_target_id}
                
            non_interested_rec = next(r for r in all_records if r["id"] != interested_rec["id"] and r["parent_response"] != "Interested")
            
            logger.info(f"Verifying outbox safeguard with bulk send containing Interested (ID: {interested_rec['id']}) and Non-Interested (ID: {non_interested_rec['id']})...")
            bulk_payload_safeguard = {"record_ids": [interested_rec["id"], non_interested_rec["id"]]}
            res = await client.post("/api/v1/campaign/send-bulk", json=bulk_payload_safeguard, headers=headers)
            assert res.status_code == 200, f"Safeguard bulk send post failed: {res.text}"
            safeguard_res = res.json()
            logger.info(f"Safeguard endpoint response: {safeguard_res['message']}")
            assert "1 records" in safeguard_res["message"] or "1 record" in safeguard_res["message"], f"Expected 1 eligible record in response, got: {safeguard_res['message']}"

            # 14. Test Fetch Recent Chats Endpoint
            logger.info("Testing Fetch Recent Chats Endpoint (/api/v1/chat/recent)...")
            chat_recent_res = await client.get("/api/v1/chat/recent", headers=headers)
            assert chat_recent_res.status_code == 200, f"Fetch recent chats failed: {chat_recent_res.text}"
            recent_chats = chat_recent_res.json()
            logger.info(f"Successfully retrieved recent chats. Count: {len(recent_chats)}")
            
            # 15. Test Fetch Chat History
            target_record_id = test_record["id"]
            logger.info(f"Testing Fetch Chat History for Record ID {target_record_id} (/api/v1/chat/history/{target_record_id})...")
            chat_hist_res = await client.get(f"/api/v1/chat/history/{target_record_id}", headers=headers)
            assert chat_hist_res.status_code == 200, f"Fetch chat history failed: {chat_hist_res.text}"
            history = chat_hist_res.json()["messages"]
            logger.info(f"Successfully retrieved chat history. Messages count: {len(history)}")
            
            # 16. Test Send Counselor Free-Form Message
            logger.info("Testing Send Manual Counselor Message (/api/v1/chat/send)...")
            send_payload = {
                "record_id": target_record_id,
                "message_text": "Hello, thank you for showing interest in admissions! How can I help you today?"
            }
            send_msg_res = await client.post("/api/v1/chat/send", json=send_payload, headers=headers)
            assert send_msg_res.status_code == 200, f"Send manual message failed: {send_msg_res.text}"
            send_msg_data = send_msg_res.json()
            assert send_msg_data["status"] == "success", "Expected success status in message sending response"
            logger.info("Confirmed: Counselor manual reply dispatched and recorded in database.")
            
            # 17. Test Auto-Reply Rules CRUD Endpoints
            logger.info("Testing Auto-Reply Rules CRUD endpoints (/api/v1/chat/rules)...")
            rules_res = await client.get("/api/v1/chat/rules", headers=headers)
            assert rules_res.status_code == 200, f"Fetch rules failed: {rules_res.text}"
            initial_rules = rules_res.json()
            logger.info(f"Initial rules list fetched. Count: {len(initial_rules)}")
            
            new_rule_payload = {
                "keyword": "scholarship",
                "reply_text": "We offer up to 100% tuition fee waiver for top board scorers and sports quota candidates. Please submit your certificates."
            }
            add_rule_res = await client.post("/api/v1/chat/rules", json=new_rule_payload, headers=headers)
            assert add_rule_res.status_code == 200, f"Add rule failed: {add_rule_res.text}"
            added_rule = add_rule_res.json()["rule"]
            assert added_rule["keyword"] == "scholarship", f"Expected rule keyword 'scholarship', got {added_rule['keyword']}"
            
            # 18. Test Webhook Ingestion & Chatbot Reply Trigger
            logger.info("Testing Webhook Ingestion with simulated custom student reply...")
            records_res = await client.get("/api/v1/records", headers=headers)
            records_list = records_res.json()["records"]
            chatbot_target = next(r for r in records_list if r["id"] != record_id)
            chatbot_target_id = chatbot_target["id"]
            chatbot_phone = chatbot_target["phone_number"]
            logger.info(f"Targeting record ID {chatbot_target_id} ({chatbot_phone}) for chatbot test...")

            import uuid
            sim_msg_id = f"wa_sim_test_msg_{uuid.uuid4().hex[:8]}"
            sim_student_text_payload = {
                "event": "incoming_text",
                "message_id": sim_msg_id,
                "from_phone": chatbot_phone,
                "text_body": "Can you tell me about scholarship criteria?"
            }
            webhook_text_res = await client.post("/api/v1/whatsapp/webhook", json=sim_student_text_payload)
            assert webhook_text_res.status_code == 200, f"Webhook text post failed: {webhook_text_res.text}"
            logger.info("Webhook text reply processed. Checking if chatbot auto-responded...")
            
            # Fetch chat history again to verify the chatbot's reply was logged
            chat_hist_after_res = await client.get(f"/api/v1/chat/history/{chatbot_target_id}", headers=headers)
            history_after = chat_hist_after_res.json()["messages"]
            
            # We expect two new messages in history: the student's question and the bot's auto-reply!
            parent_msg = next((m for m in history_after if m["message_id"] == sim_msg_id), None)
            assert parent_msg is not None, "Simulated student message was not found in chat history"
            
            # The bot's message should follow the parent message and match the scholarship rule text
            bot_msg = next((m for m in history_after if m["sender"] == "system" and "fee waiver" in m["message_text"]), None)
            assert bot_msg is not None, "Chatbot automated reply was not found in chat history"
            logger.info(f"Confirmed: Chatbot matched keyword 'scholarship' and auto-replied: '{bot_msg['message_text']}'")
            
            # Clean up: delete test rule
            logger.info("Cleaning up: Deleting test auto-reply rule...")
            delete_res = await client.delete(f"/api/v1/chat/rules/{added_rule['id']}", headers=headers)
            assert delete_res.status_code == 200, f"Delete rule failed: {delete_res.text}"
            logger.info("Cleanup completed successfully.")

            # 19. Test Contacts CRUD Endpoints
            logger.info("Testing Contacts CRUD endpoints (/api/v1/contacts)...")
            # GET list
            contacts_res = await client.get("/api/v1/contacts?limit=10", headers=headers)
            assert contacts_res.status_code == 200, f"Fetch contacts failed: {contacts_res.text}"
            contacts_data = contacts_res.json()
            initial_count = contacts_data["total"]
            logger.info(f"Initial contacts count: {initial_count}")

            # POST create
            new_contact_payload = {
                "student_name": "Test Contact",
                "parent_name": "Parent Test",
                "selected_branch": "Computer Science",
                "phone_number": "8888888888",
                "pipeline_tag": "Lead"
            }
            create_res = await client.post("/api/v1/contacts", json=new_contact_payload, headers=headers)
            assert create_res.status_code == 200, f"Create contact failed: {create_res.text}"
            created_contact = create_res.json()["contact"]
            assert created_contact["student_name"] == "Test Contact"
            assert created_contact["phone_number"] == "918888888888" # Normalized
            logger.info("Created new manual contact with phone normalization.")

            # POST create duplicate check
            dup_res = await client.post("/api/v1/contacts", json=new_contact_payload, headers=headers)
            assert dup_res.status_code == 400, f"Expected duplicate error 400, got: {dup_res.status_code}"
            logger.info("Duplicate contact creation correctly rejected.")

            # PUT update
            update_payload = {
                "student_name": "Updated Test Contact",
                "pipeline_tag": "Contacted"
            }
            contact_id = created_contact["id"]
            update_res = await client.put(f"/api/v1/contacts/{contact_id}", json=update_payload, headers=headers)
            assert update_res.status_code == 200, f"Update contact failed: {update_res.text}"
            updated_contact = update_res.json()["contact"]
            assert updated_contact["student_name"] == "Updated Test Contact"
            assert updated_contact["pipeline_tag"] == "Contacted"
            logger.info("Successfully updated contact details.")

            # DELETE contact
            delete_contact_res = await client.delete(f"/api/v1/contacts/{contact_id}", headers=headers)
            assert delete_contact_res.status_code == 200, f"Delete contact failed: {delete_contact_res.text}"
            
            # Verify deleted contact is gone
            contacts_after_res = await client.get("/api/v1/contacts?limit=10", headers=headers)
            assert contacts_after_res.json()["total"] == initial_count, "Deleted contact still exists in total count"
            logger.info("Contact deletion verified.")

            # 20. Test Contacts Bulk Ingestion (Spreadsheet Upload)
            logger.info("Testing Contacts Spreadsheet Ingestion (/api/v1/contacts/upload)...")
            contacts_csv = (
                "Student Name,Parent Name,Selected Branch,Phone Number\n"
                "Ingest Student 1,Parent Ingest 1,Information Technology,7777777777\n"
                "Ingest Student 2,Parent Ingest 2,Electronics,6666666666\n"
            )
            contacts_csv_bytes = contacts_csv.encode("utf-8")
            upload_files = {"file": ("test_contacts_upload.csv", contacts_csv_bytes, "text/csv")}
            
            upload_res = await client.post("/api/v1/contacts/upload", files=upload_files, headers=headers)
            assert upload_res.status_code == 200, f"Contacts upload failed: {upload_res.text}"
            upload_json = upload_res.json()
            assert upload_json["added"] == 2 or upload_json["updated"] == 2, f"Expected 2 added or updated contacts, got: added={upload_json['added']}, updated={upload_json['updated']}"
            logger.info("Contacts uploaded via CSV successfully.")

            logger.info("All integration tests PASSED successfully.")
            
        except AssertionError as ae:
            logger.error(f"Integration Test Assertion Failed: {ae}")
        except Exception as e:
            logger.error(f"Test Execution Error: {e}")

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--run":
        asyncio.run(run_tests())
    else:
        print("\n=== Integration Test Ready ===")
        print("To run these tests, first launch the backend engine:")
        print("  1. Ensure your PostgreSQL instance is running and configured via DATABASE_URL")
        print("  2. Start the FastAPI server: uvicorn backend.main:app --reload")
        print("  3. Run the verification test suite:")
        print(f"     python {sys.argv[0]} --run\n")
