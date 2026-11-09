"""Aggregates venture token usage per founder (see venture-usage-report.sh).

Inputs: a TSV of founder messages from production and the app's usage log
lines. Log lines link to founders through the turn's request ID (chat steps,
research digests, assessments) or the conversation ID (history summaries).
"""
import json
import sys
from collections import defaultdict

# OpenAI list prices per 1M tokens: input, cached input, output (developers.openai.com/api/docs/pricing).
PRICES = {
    "gpt-6-astra": (10.00, 1.00, 50.00), "gpt-6.1-sol": (2.00, 0.10, 10.00), "gpt-6.1-terra": (1.00, 0.05, 5.00),
    "gpt-6-luna": (0.10, 0.01, 0.50), "gpt-5.6-sol": (4.00, 0.40, 20.00), "gpt-5.6-terra": (2.00, 0.20, 12.00),
    "gpt-5.6-luna": (0.20, 0.02, 1.20),
}

messages_path, usage_path = sys.argv[1], sys.argv[2]
founders = {}                      # email -> {name, conversations: {id: title}, ...}
owner_of_request, owner_of_conversation = {}, {}
for line in open(messages_path, encoding="utf-8"):
    cols = line.rstrip("\n").split("\t")
    if len(cols) < 10:
        continue
    name, email, conv, title, request, role, status, chars, sources, assessments = cols[:10]
    f = founders.setdefault(email, {"name": name, "conversations": {}, "user_messages": 0, "replies": 0,
                                    "chars": 0, "sources": {}, "assessments": {}, "logged_turns": set(), "turns": set()})
    f["conversations"][conv] = title
    f["sources"][conv], f["assessments"][conv] = int(sources or 0), int(assessments or 0)
    f["chars"] += int(chars or 0)
    if role == "user":
        f["user_messages"] += 1
    elif status == "completed":
        f["replies"] += 1
    f["turns"].add(request)
    owner_of_request[request] = email
    owner_of_conversation[conv] = email

usage = defaultdict(lambda: defaultdict(lambda: [0, 0, 0, 0, 0]))  # email -> model -> [calls, input, cached, output, reasoning]
for line in open(usage_path, encoding="utf-8", errors="replace"):
    start = line.find("{")
    if start < 0:
        continue
    try:
        event = json.loads(line[start:])
    except ValueError:
        continue
    turn = event.get("turnId") or event.get("requestId")
    email = owner_of_request.get(turn) or owner_of_conversation.get(event.get("requestId"))
    if not email or event.get("inputTokens") is None:
        continue
    founders[email]["logged_turns"].add(turn)
    row = usage[email][event.get("model") or "unknown"]
    row[0] += 1
    row[1] += event.get("inputTokens") or 0
    row[2] += event.get("cachedInputTokens") or 0
    row[3] += event.get("outputTokens") or 0
    row[4] += event.get("reasoningTokens") or 0

if not founders:
    print("No matching founders or venture messages found.")
for email, f in founders.items():
    print(f"\n{f['name']} <{email}>")
    for conv, title in f["conversations"].items():
        print(f"  venture: {title}  ({f['sources'][conv]} sources, {f['assessments'][conv]} saved assessments)")
    print(f"  messages: {f['user_messages']} from the founder, {f['replies']} analyst replies")
    total_tokens, total_cost = 0, 0.0
    for model, (calls, inp, cached, out, reasoning) in sorted(usage[email].items()):
        price = PRICES.get(model)
        cost = (max(inp - cached, 0) * price[0] + cached * price[1] + out * price[2]) / 1e6 if price else None
        total_tokens += inp + out
        total_cost += cost or 0
        print(f"  {model:15} {calls:4} calls  in {inp:>9,} (cached {cached:,})  out {out:>8,} (reasoning {reasoning:,})"
              + (f"  ≈ ${cost:.3f}" if cost is not None else "  (no price)"))
    print(f"  logged total: {total_tokens:,} tokens  ≈ ${total_cost:.3f} at list prices")
    unlogged = len(f["turns"] - f["logged_turns"])
    if unlogged:
        logged = len(f["logged_turns"])
        extra = f"about {int(total_tokens / logged * unlogged):,} more tokens at this founder's logged average" if logged else "usage unknown"
        print(f"  {unlogged} request IDs have no usage logs (before logging shipped, logs rotated, or no model call): {extra}")
