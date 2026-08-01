import asyncio
import argparse
import bcrypt
import os
from sqlalchemy import select

# Support running from root or importing properly
import sys
sys.path.insert(0, os.getcwd())

from backend.database import AsyncSessionLocal, AdminUser

async def reset_password(username, password):
    async with AsyncSessionLocal() as session:
        stmt = select(AdminUser).where(AdminUser.username == username)
        res = await session.execute(stmt)
        user = res.scalar_one_or_none()
        
        hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        if user:
            user.hashed_password = hashed
            print(f"Successfully updated password for user: '{username}'")
        else:
            user = AdminUser(username=username, hashed_password=hashed)
            session.add(user)
            print(f"User '{username}' did not exist. Created new admin account with specified password.")
        
        await session.commit()

def main():
    parser = argparse.ArgumentParser(description="Reset database administrator password")
    parser.add_argument("--username", required=True, help="Admin username")
    parser.add_argument("--password", required=True, help="New password")
    args = parser.parse_args()
    
    asyncio.run(reset_password(args.username, args.password))

if __name__ == "__main__":
    main()
