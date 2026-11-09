#!/usr/bin/env python3
"""Disposable DB only. Exactly 10 of 32 independent connections win one shared window."""
import concurrent.futures, os, subprocess, uuid
url = os.environ['PGURL']
key = uuid.uuid4().hex * 2
sql = "set role service_role; select public.control_check_rate_limit('%s',10,60000)->>'allowed';" % key
def call(_):
    return subprocess.check_output(['psql', url, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], text=True).strip()
with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
    answers = list(pool.map(call, range(32)))
assert answers.count('true') == 10, answers
assert answers.count('false') == 22, answers
print('32 independent connections: exactly 10 allowed, 22 refused')
