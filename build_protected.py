import os
import sys
import shutil
import zipfile
import argparse
import subprocess

def run_cmd(cmd, shell=False):
    print(f"Executing: {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    res = subprocess.run(cmd, shell=shell, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"Error executing command: {res.stderr}")
        if "out of license" in res.stderr.lower() or "license" in res.stderr.lower():
            print("\n💡 [PyArmor License Notice]")
            print("The build failed because PyArmor is running in Trial mode on this machine.")
            print("PyArmor's Trial version has a strict size limit on compiled files (main.py is ~154KB).")
            print("To compile successfully, please register your commercial PyArmor license on this machine.")
        sys.exit(res.returncode)
    return res.stdout

def main():
    parser = argparse.ArgumentParser(description="Build PyArmor Obfuscated Release Package")
    parser.add_argument("--mac", required=True, help="Target server network interface MAC address license binding")
    parser.add_argument("--platform", default="windows.x86_64,linux.x86_64", help="Target compile platform targets")
    args = parser.parse_args()

    mac = args.mac.strip()
    platforms = [p.strip() for p in args.platform.split(",") if p.strip()]

    # 1. Install / Upgrade pyarmor
    print("Installing / upgrading pyarmor...")
    run_cmd([sys.executable, "-m", "pip", "install", "--upgrade", "pyarmor"])

    # 2. Clean previous build directories
    dist_dir = os.path.join(os.getcwd(), "dist")
    if os.path.exists(dist_dir):
        print(f"Cleaning previous build folder: {dist_dir}")
        shutil.rmtree(dist_dir)
    os.makedirs(dist_dir, exist_ok=True)

    # 3. Obfuscate backend using PyArmor
    # Syntax: pyarmor gen -O dist/backend -b "[Target_MAC]" --platform windows.x86_64 --platform linux.x86_64 -r backend
    pyarmor_cmd = ["pyarmor", "gen", "-O", os.path.join("dist", "backend"), "-b", mac]
    for p in platforms:
        pyarmor_cmd.extend(["--platform", p])
    pyarmor_cmd.extend(["-r", "backend"])

    print("Obfuscating backend codebase using PyArmor...")
    try:
        run_cmd(pyarmor_cmd, shell=True)
    except Exception as e:
        run_cmd(pyarmor_cmd, shell=False)

    print("Obfuscation successful! Output located in dist/backend/")

    # 4. Package release into a secure zip file
    zip_filename = "release_protected.zip"
    if os.path.exists(zip_filename):
        os.remove(zip_filename)

    print(f"Creating release package: {zip_filename}...")
    release_files = [
        "Dockerfile",
        "docker-compose.yml",
        "entrypoint.sh",
        ".dockerignore",
        ".env.example",
        "requirements.txt"
    ]

    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Add root deployment configurations
        for f in release_files:
            if os.path.exists(f):
                print(f"Packaging deployment file: {f}")
                zipf.write(f)
            else:
                print(f"Warning: Configuration file {f} not found, skipping.")

        # Add obfuscated backend folder
        backend_dist = os.path.join("dist", "backend")
        if os.path.exists(backend_dist):
            for root, dirs, files in os.walk(backend_dist):
                for file in files:
                    filepath = os.path.join(root, file)
                    archive_name = os.path.relpath(filepath, os.getcwd())
                    zipf.write(filepath, archive_name)

        # Add frontend folder (excluding node_modules, dist, etc.)
        frontend_dir = "frontend"
        if os.path.exists(frontend_dir):
            for root, dirs, files in os.walk(frontend_dir):
                if "node_modules" in root or ".git" in root or "dist" in root:
                    continue
                for file in files:
                    filepath = os.path.join(root, file)
                    archive_name = os.path.relpath(filepath, os.getcwd())
                    zipf.write(filepath, archive_name)

    print(f"Success! Secure release package generated: {os.path.abspath(zip_filename)}")

if __name__ == "__main__":
    main()
