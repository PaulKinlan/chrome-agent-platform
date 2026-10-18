# rn0ky bridge patches (agents repo)

These are patches for **PaulKinlan/agents**, not for this repository. They live here because our VM
has no write access to the agents repo (fleet-2cc8e: the github.int mirror answers 403
"integration is read-only" for agents and the github.com token is invalid, while
chrome-agent-platform pushes fine through its own mirror). This public branch is the transport.

- `0001-rn0ky-bounded-batching.patch` — the whole change against **agents @ 6e25e82**
  (origin/main when it was cut): `lib/candidate_batching.py`, the `factory` batching/contract/named-
  truncation wiring, `lib/findings.py` presented-ids preference, `agents/perf-review/agent.yaml`
  opt-in, and both test files (30 unit + 5 end-to-end).

Apply on a checkout of PaulKinlan/agents at 6e25e82 (or any commit whose `factory`/`lib` still match):

```bash
cd /path/to/agents
git checkout -b fleet/rn0ky-apply 6e25e82
git am 0001-rn0ky-bounded-batching.patch        # or: patch -p1 < 0001-rn0ky-bounded-batching.patch
python3 -m unittest tests.test_candidate_batching tests.test_candidate_batching_end_to_end
```

Delete this repository-side directory once the change has landed in agents.
