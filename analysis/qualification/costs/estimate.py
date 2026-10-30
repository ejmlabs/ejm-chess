#!/usr/bin/env python3
"""Reproduce hypothetical cost arithmetic, without contacting Cloudflare."""

from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
import hashlib
import json
from pathlib import Path
import re


HERE = Path(__file__).resolve().parent
PRODUCT = HERE.parents[2]
MILLION = Decimal(1_000_000)
SOURCES = json.loads((HERE / "pricing-sources.json").read_text())
RATES = SOURCES["rates"]


def decimal(value):
    return Decimal(str(value))


def money(value):
    return str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def charge(usage, included, rate, scale=1, rounded=False):
    excess = max(Decimal(0), decimal(usage) - decimal(included))
    units = excess / decimal(scale)
    if rounded:
        units = units.to_integral_value(rounding=ROUND_CEILING)
    return units * decimal(rate)


def estimate(inputs, inclusions):
    def allowance(key):
        return RATES[key] if inclusions else 0

    duration = (
        decimal(inputs["games"]) * decimal(inputs["billed_active_seconds_per_game"])
        + decimal(inputs["other_billed_active_object_seconds"])
    ) * decimal(RATES["do_allocated_gb_for_duration"])
    lines = {
        "allocated_paid_base": decimal(RATES["allocated_workers_paid_base_monthly"]),
        "worker_requests": charge(inputs["worker_requests"], allowance("workers_requests_included"), RATES["workers_requests_per_million"], MILLION),
        "worker_cpu": charge(inputs["worker_cpu_ms"], allowance("workers_cpu_ms_included"), RATES["workers_cpu_ms_per_million"], MILLION),
        "do_requests": charge(inputs["do_equivalent_requests"], allowance("do_requests_included"), RATES["do_requests_per_started_million"], MILLION, rounded=True),
        "do_duration": charge(duration, allowance("do_duration_gb_seconds_included"), RATES["do_duration_per_started_million_gb_seconds"], MILLION, rounded=True),
        "do_sql_reads": charge(inputs["do_sql_rows_read"], allowance("do_sql_rows_read_included"), RATES["do_sql_rows_read_per_million"], MILLION),
        "do_sql_writes": charge(inputs["do_sql_rows_written"], allowance("do_sql_rows_written_included"), RATES["do_sql_rows_written_per_million"], MILLION),
        "do_sql_storage": charge(inputs["do_sql_storage_gb_months"], allowance("do_sql_storage_gb_months_included"), RATES["do_sql_storage_per_gb_month"]),
        "d1_reads": charge(inputs["d1_rows_read"], allowance("d1_rows_read_included"), RATES["d1_rows_read_per_million"], MILLION),
        "d1_writes": charge(inputs["d1_rows_written"], allowance("d1_rows_written_included"), RATES["d1_rows_written_per_million"], MILLION),
        "d1_storage": charge(inputs["d1_storage_gb_months"], allowance("d1_storage_gb_months_included"), RATES["d1_storage_per_gb_month"]),
        "email": charge(inputs["accepted_outbound_emails"], allowance("outbound_email_included"), RATES["outbound_email_per_thousand"], 1000),
    }
    total = sum(lines.values(), Decimal(0))
    return {
        "do_duration_gb_seconds": str(duration),
        "line_items_usd": {name: str(value) for name, value in lines.items()},
        "total_allocated_usd": money(total),
        "allocated_usd_per_1000_games": money(total / decimal(inputs["games"]) * 1000),
    }


SCENARIOS = {
    "lower_5000": {
        "games": 5000,
        "billed_active_seconds_per_game": 10,
        "other_billed_active_object_seconds": 86400,
        "worker_requests": 1000000,
        "worker_cpu_ms": 2000000,
        "do_equivalent_requests": 500000,
        "do_sql_rows_read": 25000000,
        "do_sql_rows_written": 5000000,
        "do_sql_storage_gb_months": "1",
        "d1_rows_read": 5000000,
        "d1_rows_written": 1000000,
        "d1_storage_gb_months": "1",
        "accepted_outbound_emails": 1000,
    },
    "higher_5000": {
        "games": 5000,
        "billed_active_seconds_per_game": 2400,
        "other_billed_active_object_seconds": 2592000,
        "worker_requests": 20000000,
        "worker_cpu_ms": 200000000,
        "do_equivalent_requests": 5000000,
        "do_sql_rows_read": 1000000000,
        "do_sql_rows_written": 40000000,
        "do_sql_storage_gb_months": "5",
        "d1_rows_read": 100000000,
        "d1_rows_written": 10000000,
        "d1_storage_gb_months": "1",
        "accepted_outbound_emails": 1000,
    },
    "higher_10000_sensitivity": {
        "games": 10000,
        "billed_active_seconds_per_game": 2400,
        "other_billed_active_object_seconds": 2592000,
        "worker_requests": 30000000,
        "worker_cpu_ms": 300000000,
        "do_equivalent_requests": 9000000,
        "do_sql_rows_read": 1900000000,
        "do_sql_rows_written": 75000000,
        "do_sql_storage_gb_months": "9",
        "d1_rows_read": 190000000,
        "d1_rows_written": 19000000,
        "d1_storage_gb_months": "1.8",
        "accepted_outbound_emails": 1000,
    },
}


def main():
    config = PRODUCT / "wrangler.jsonc"
    config_bytes = config.read_bytes()
    config_text = config_bytes.decode()

    def setting(name):
        match = re.search(r'"' + re.escape(name) + r'"\s*:\s*(true|false|"[^"]*"|[0-9]+)', config_text)
        if match is None:
            raise ValueError(f"Missing canonical configuration setting: {name}")
        return json.loads(match.group(1))

    sustained_duration = Decimal(1000 * 30 * 24 * 60 * 60) * decimal(RATES["do_allocated_gb_for_duration"])
    result = {
        "kind": "Hypothetical allocation sensitivity, not measured usage, capacity, or an upper bill bound",
        "currency": SOURCES["currency"],
        "pricing_date": SOURCES["pricing_checked_local_date"],
        "modeled_days": 30,
        "configuration": {
            "path": "wrangler.jsonc",
            "sha256_at_generation": hashlib.sha256(config_bytes).hexdigest(),
            "observed": {
                "assets.run_worker_first": setting("run_worker_first"),
                "NEW_WORK_STOPPED": setting("NEW_WORK_STOPPED"),
                "MONTHLY_GAME_LIMIT": setting("MONTHLY_GAME_LIMIT"),
                "MONTHLY_EMAIL_LIMIT": setting("MONTHLY_EMAIL_LIMIT"),
                "MONTHLY_ANALYSIS_LIMIT": setting("MONTHLY_ANALYSIS_LIMIT"),
                "ANALYSIS_ENABLED": setting("ANALYSIS_ENABLED"),
                "limits.cpu_ms": setting("cpu_ms"),
                "server_analysis_bindings_present": bool(re.search(r'"(?:containers|queues)"\s*:', config_text)),
                "observability.enabled": setting("enabled"),
            },
            "limit": "First canonical source occurrences, before the local environment overrides. This generator does not inspect deployed settings or account usage, and does not choose scenario inputs from the configuration.",
        },
        "scenario_construction": {
            "lower": "Assumes 10 seconds of billed game activity per game and 86400 other active object-seconds. Neither value is measured.",
            "higher": "Assumes every game is billed active for 40 minutes and one additional object is billed active throughout a 30-day month.",
            "10000": "Doubles game-dependent units from higher_5000, keeping fixed 10M Worker requests, 100M CPU ms, 1M DO requests, 5M DO writes, 100M DO reads, 1 GB DO storage, 1M D1 writes, 10M D1 reads, 0.2 GB D1 storage, maintenance duration and email unchanged.",
            "public_traffic": "Worker totals explicitly include assumed asset, authentication, public-read, denial, and maintenance requests. Game admission does not bound those totals.",
        },
        "scenarios": {
            name: {
                "inputs": inputs,
                "published_inclusions_available": estimate(inputs, True),
                "no_inclusions_available": estimate(inputs, False),
            }
            for name, inputs in SCENARIOS.items()
        },
        "sustained_1000_active_objects": {
            "object_seconds": 1000 * 30 * 24 * 60 * 60,
            "gb_seconds": str(sustained_duration),
            "duration_only_usd_with_inclusion": money(charge(sustained_duration, RATES["do_duration_gb_seconds_included"], RATES["do_duration_per_started_million_gb_seconds"], MILLION, rounded=True)),
            "limit": "Deliberate sustained billed-active assumption. This is not hibernating capacity or a proposed authorized workload.",
        },
        "spectator_unit_example": {
            "spectator_hours": 10000,
            "refresh_interval_seconds": 10,
            "requests": 3600000,
            "assumed_cpu_ms_per_request": 10,
            "worker_cpu_ms": 36000000,
            "worker_only_marginal_usd_no_inclusions": money(charge(3600000, 0, RATES["workers_requests_per_million"], MILLION) + charge(36000000, 0, RATES["workers_cpu_ms_per_million"], MILLION)),
            "limit": "Arithmetic example only. Excludes initial assets, authentication, reconnects, database misses, projections, storage, and plan fee.",
        },
        "qualification_gate": {
            "target_unique_settlements_per_second": 20,
            "target_duration_seconds": 900,
            "target_unique_games": 18000,
            "current_monthly_game_default": 5000,
            "hard_setting_ceiling": 10000,
            "spend_measured": False,
            "authorized_by_this_estimate": False,
        },
    }
    (HERE / "estimates.json").write_text(json.dumps(result, indent=2) + "\n")
    for name, row in result["scenarios"].items():
        print(name, row["published_inclusions_available"]["total_allocated_usd"], row["no_inclusions_available"]["total_allocated_usd"])


if __name__ == "__main__":
    main()
