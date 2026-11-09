"""Create a clean handoff archive. Never includes secrets, build caches or Git identity."""
from pathlib import Path
import zipfile
import sys

root = Path(__file__).resolve().parents[1]
destination = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / 'Manzanilla-Admin-Foundation.zip'
excluded = {'.git', '.next', 'node_modules', 'coverage', 'test-results', 'playwright-report', '.openai', '.vercel'}
files = []
for source in sorted(root.rglob('*')):
    relative = source.relative_to(root)
    if not source.is_file() or source.is_symlink() or excluded.intersection(relative.parts):
        continue
    if source.name.startswith('.env') and source.name != '.env.example':
        continue
    if source.suffix in {'.zip', '.tsbuildinfo', '.log'}:
        continue
    files.append((source, relative))
if not files:
    raise SystemExit('No source files found')
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for source, relative in files:
        archive.write(source, Path('manzanilla-admin') / relative)
print(f'{destination}: {len(files)} files, {destination.stat().st_size:,} bytes')
