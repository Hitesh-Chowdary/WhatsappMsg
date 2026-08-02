import os
import zipfile
import shutil
import argparse
import sys

def main():
    parser = argparse.ArgumentParser(description="Build Release Package")
    parser.add_argument("--name", default="", help="Client or release name suffix for the zip package")
    # Keep parameters for backward compatibility checks
    parser.add_argument("--mac", default="", help="Obsolete parameter (bypassed)")
    parser.add_argument("--platform", default="", help="Obsolete parameter (bypassed)")
    parser.add_argument("--no-obfuscate", action="store_true", help="Obsolete parameter (bypassed)")
    args = parser.parse_args()

    # Determine filename
    suffix = f"_{args.name.strip()}" if args.name.strip() else ""
    zip_filename = f"release{suffix}.zip"
    if os.path.exists(zip_filename):
        os.remove(zip_filename)

    print(f"Creating release package: {zip_filename}...")
    release_files = [
        "Dockerfile",
        "docker-compose.yml",
        "entrypoint.sh",
        ".dockerignore",
        ".env.example",
        "requirements.txt",
        "run_production.bat",
        "start.bat",
        "reset_password.py",
        "README.md"
    ]

    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Add root deployment configurations
        for f in release_files:
            if os.path.exists(f):
                print(f"Packaging deployment file: {f}")
                # Ensure shell scripts have Unix LF line endings to prevent container startup failure
                if f.endswith(".sh") or f == "entrypoint.sh":
                    with open(f, "rb") as sf:
                        script_content = sf.read()
                    script_content_lf = script_content.replace(b"\r\n", b"\n")
                    zipf.writestr(f, script_content_lf)
                else:
                    zipf.write(f)
            else:
                print(f"Warning: Configuration file {f} not found, skipping.")

        # Add raw backend folder
        backend_dir = "backend"
        if os.path.exists(backend_dir):
            print("Packaging backend codebase...")
            for root, dirs, files in os.walk(backend_dir):
                if "__pycache__" in root or ".pytest_cache" in root:
                    continue
                for file in files:
                    filepath = os.path.join(root, file)
                    archive_name = os.path.relpath(filepath, os.getcwd())
                    zipf.write(filepath, archive_name)

        # Add frontend folder (excluding node_modules, dist, etc.)
        frontend_dir = "frontend"
        if os.path.exists(frontend_dir):
            print("Packaging frontend codebase...")
            for root, dirs, files in os.walk(frontend_dir):
                if "node_modules" in root or ".git" in root or "dist" in root:
                    continue
                for file in files:
                    filepath = os.path.join(root, file)
                    archive_name = os.path.relpath(filepath, os.getcwd())
                    zipf.write(filepath, archive_name)

    print(f"Success! Release package generated: {os.path.abspath(zip_filename)}")

if __name__ == "__main__":
    main()
