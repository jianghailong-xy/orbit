"""Run /upgrade's two copies as they are at a given commit against new_deployment_test.py's fake docker, for a
deployment without the managed runners' profile, and print every docker call each makes (the pre-D6 baseline)."""
import os, re, shutil, stat, subprocess, sys, tempfile
from pathlib import Path

repo = Path(sys.argv[1]); commit = sys.argv[2]
sys.path.insert(0, str(repo / "scripts/managed-runner"))
import importlib.util
spec = importlib.util.spec_from_file_location("nd", repo / "scripts/managed-runner/new_deployment_test.py")
nd = importlib.util.module_from_spec(spec); spec.loader.exec_module(nd)
for upgrade in nd.UPGRADES:
    root = Path(tempfile.mkdtemp(prefix="d6-baseline-"))
    checkout = root / "orbit"
    for rel in [*nd.UPGRADES, ".env.example", ".gitignore", "docker-compose.yml"]:
        target = checkout / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(subprocess.run(["git", "-C", str(repo), "show", f"{commit}:{rel}"], check=True, capture_output=True).stdout)
        if rel.endswith(".sh"):
            target.chmod(0o755)
    bin_dir = root / "bin"; bin_dir.mkdir()
    (bin_dir / "docker").write_text(nd.FAKE_DOCKER); (bin_dir / "docker").chmod(0o755)
    log = root / "docker.log"; log.write_text("")
    env = {**{k: v for k, v in os.environ.items() if not k.startswith(("ORBIT_", "COMPOSE_", "GIT_"))},
           "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_DOCKER_LOG": str(log), "FAKE_IMAGE_ID": nd.IMAGE_ID,
           "FAKE_GATEWAY": nd.GATEWAY, "GIT_AUTHOR_NAME": "f", "GIT_AUTHOR_EMAIL": "f@e.invalid",
           "GIT_COMMITTER_NAME": "f", "GIT_COMMITTER_EMAIL": "f@e.invalid", "GIT_CEILING_DIRECTORIES": str(root)}
    for args in (["init", "-q", "--initial-branch=main"], ["add", "."], ["commit", "-q", "-m", "fixture"]):
        subprocess.run(["git", *args], cwd=checkout, env=env, check=True, capture_output=True)
    (checkout / ".env").write_text('JWT_SECRET="kept"\nPROVIDER_SECRET_KEY="kept too"\nPUBLIC_ORIGIN="http://localhost:2086"\n')
    run = subprocess.run([str(checkout / upgrade), "--no-pull"], cwd=checkout, env=env, capture_output=True, text=True)
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=checkout, env=env, capture_output=True, text=True).stdout.strip()
    print(f"== {upgrade} at {commit}: exit {run.returncode}")
    for line in log.read_text().splitlines():
        print("   " + line.replace(head, "<HEAD>"))
    shutil.rmtree(root)
