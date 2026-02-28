#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

ALLOWED_STATUSES = {"OK", "WARN", "FAIL"}
DENOM_CHECK_MONTHS = {1, 7}
AMENITY_CHECK_MONTHS = {1, 4, 7, 10}
OSM_CATEGORIES = {"gp_clinics", "dental", "childcare_preschool", "supermarkets", "eldercare"}
DEFAULT_STALE_AFTER_SECONDS = 120 * 24 * 3600


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (
        value.astimezone(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        if len(text) == 10 and text[4] == "-" and text[7] == "-":
            parsed = date.fromisoformat(text)
            return datetime(parsed.year, parsed.month, parsed.day, tzinfo=timezone.utc)
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def to_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def to_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_bool(value: str | None) -> bool:
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def dedupe_strings(values: list[Any]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        text = str(value).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def month_in_timezone(reference: datetime, tz_name: str) -> int:
    if ZoneInfo is None:
        return int(reference.astimezone(timezone.utc).strftime("%m"))
    try:
        return int(reference.astimezone(ZoneInfo(tz_name)).strftime("%m"))
    except Exception:  # noqa: BLE001
        return int(reference.astimezone(timezone.utc).strftime("%m"))


def parse_snapshot(value: Any) -> tuple[int, int] | None:
    text = str(value or "").strip()
    matched = re.match(r"^(\d{4})Q([1-4])$", text)
    if not matched:
        return None
    return int(matched.group(1)), int(matched.group(2))


def latest_snapshot(values: Any) -> str | None:
    if not isinstance(values, list):
        return None
    best_raw = None
    best_key: tuple[int, int] | None = None
    for value in values:
        key = parse_snapshot(value)
        if key is None:
            continue
        if best_key is None or key > best_key:
            best_key = key
            best_raw = str(value)
    return best_raw


def read_json_file(path: Path) -> tuple[Any | None, str | None]:
    if not path.exists():
        return None, f"{path.as_posix()} is missing"
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except Exception as exc:  # noqa: BLE001
        return None, f"{path.as_posix()} is malformed ({exc})"


def sum_category_counts(rows: Any, categories: set[str]) -> int:
    if not isinstance(rows, list):
        return 0
    total = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get("category", "")) not in categories:
            continue
        count = to_int(row.get("count"))
        if count is None:
            continue
        total += count
    return total


def collect_repo_state(root: Path) -> dict[str, Any]:
    data_dir = root / "web" / "data"
    warnings: list[str] = []
    errors: list[str] = []
    row_counts: dict[str, int] = {
        "denoms_vintages": 0,
        "amenities_snapshots": 0,
        "amenities_rows_sz": 0,
        "amenities_rows_pa": 0,
        "schools_primary_points": 0,
        "schools_secondary_points": 0,
        "overpass_points_total": 0,
    }

    denoms_index_path = data_dir / "denoms_index.json"
    amenities_index_path = data_dir / "amenities_index.json"
    denoms_index, denoms_index_err = read_json_file(denoms_index_path)
    amenities_index, amenities_index_err = read_json_file(amenities_index_path)
    if denoms_index_err:
        errors.append(denoms_index_err)
    if amenities_index_err:
        errors.append(amenities_index_err)
    if denoms_index is not None and not isinstance(denoms_index, dict):
        errors.append(f"{denoms_index_path.as_posix()} should be a JSON object")
        denoms_index = None
    if amenities_index is not None and not isinstance(amenities_index, dict):
        errors.append(f"{amenities_index_path.as_posix()} should be a JSON object")
        amenities_index = None

    vintages: list[int] = []
    raw_vintages = (denoms_index or {}).get("vintages")
    if isinstance(raw_vintages, list):
        for raw in raw_vintages:
            parsed = to_int(raw)
            if parsed is not None:
                vintages.append(parsed)
    vintages = sorted(set(vintages))
    row_counts["denoms_vintages"] = len(vintages)
    latest_year = vintages[-1] if vintages else None

    raw_snapshots = (amenities_index or {}).get("snapshots")
    row_counts["amenities_snapshots"] = len(raw_snapshots) if isinstance(raw_snapshots, list) else 0
    latest_snap = latest_snapshot(raw_snapshots)

    denoms_pa = None
    denoms_sz = None
    if latest_year is not None:
        denoms_pa_path = data_dir / f"denoms_pa_{latest_year}.json"
        denoms_sz_path = data_dir / f"denoms_sz_{latest_year}.json"
        denoms_pa, denoms_pa_err = read_json_file(denoms_pa_path)
        denoms_sz, denoms_sz_err = read_json_file(denoms_sz_path)
        if denoms_pa_err:
            errors.append(denoms_pa_err)
        if denoms_sz_err:
            errors.append(denoms_sz_err)
        if denoms_pa is not None and not isinstance(denoms_pa, list):
            errors.append(f"{denoms_pa_path.as_posix()} should be a JSON array")
            denoms_pa = None
        if denoms_sz is not None and not isinstance(denoms_sz, list):
            errors.append(f"{denoms_sz_path.as_posix()} should be a JSON array")
            denoms_sz = None
    else:
        warnings.append("No denominator vintages listed in web/data/denoms_index.json.")

    amenities_pa = None
    amenities_sz = None
    amenities_debug = None
    if latest_snap is not None:
        amenities_pa_path = data_dir / f"amenities_pa_{latest_snap}.json"
        amenities_sz_path = data_dir / f"amenities_sz_{latest_snap}.json"
        amenities_debug_path = data_dir / f"amenities_debug_{latest_snap}.json"
        amenities_pa, amenities_pa_err = read_json_file(amenities_pa_path)
        amenities_sz, amenities_sz_err = read_json_file(amenities_sz_path)
        if amenities_pa_err:
            errors.append(amenities_pa_err)
        if amenities_sz_err:
            errors.append(amenities_sz_err)
        if amenities_pa is not None and not isinstance(amenities_pa, list):
            errors.append(f"{amenities_pa_path.as_posix()} should be a JSON array")
            amenities_pa = None
        if amenities_sz is not None and not isinstance(amenities_sz, list):
            errors.append(f"{amenities_sz_path.as_posix()} should be a JSON array")
            amenities_sz = None

        if amenities_debug_path.exists():
            amenities_debug, amenities_debug_err = read_json_file(amenities_debug_path)
            if amenities_debug_err:
                warnings.append(amenities_debug_err)
            if amenities_debug is not None and not isinstance(amenities_debug, dict):
                warnings.append(f"{amenities_debug_path.as_posix()} should be a JSON object")
                amenities_debug = None
    else:
        warnings.append("No amenity snapshots listed in web/data/amenities_index.json.")

    row_counts["amenities_rows_pa"] = len(amenities_pa) if isinstance(amenities_pa, list) else 0
    row_counts["amenities_rows_sz"] = len(amenities_sz) if isinstance(amenities_sz, list) else 0

    debug_totals = {}
    if isinstance(amenities_debug, dict):
        stats = amenities_debug.get("stats")
        if isinstance(stats, dict) and isinstance(stats.get("total"), dict):
            debug_totals = stats["total"]

    primary = to_int(debug_totals.get("primary_schools"))
    secondary = to_int(debug_totals.get("secondary_schools"))
    row_counts["schools_primary_points"] = (
        primary if primary is not None else sum_category_counts(amenities_pa, {"primary_schools"})
    )
    row_counts["schools_secondary_points"] = (
        secondary if secondary is not None else sum_category_counts(amenities_pa, {"secondary_schools"})
    )

    overpass_total = 0
    if debug_totals:
        all_present = True
        for category in OSM_CATEGORIES:
            count = to_int(debug_totals.get(category))
            if count is None:
                all_present = False
                break
            overpass_total += count
        if not all_present:
            overpass_total = sum_category_counts(amenities_pa, OSM_CATEGORIES)
    else:
        overpass_total = sum_category_counts(amenities_pa, OSM_CATEGORIES)
    row_counts["overpass_points_total"] = overpass_total

    max_updated_at = None
    if isinstance(denoms_index, dict):
        parsed = parse_dt(str(denoms_index.get("updated_at") or ""))
        if parsed:
            max_updated_at = parsed
        elif denoms_index.get("updated_at"):
            warnings.append("web/data/denoms_index.json updated_at is malformed.")
    if isinstance(amenities_index, dict):
        parsed = parse_dt(str(amenities_index.get("updated_at") or ""))
        if parsed and (max_updated_at is None or parsed > max_updated_at):
            max_updated_at = parsed
        elif amenities_index.get("updated_at") and parsed is None:
            warnings.append("web/data/amenities_index.json updated_at is malformed.")

    schema_fingerprint = {
        "denoms_index_keys": sorted((denoms_index or {}).keys()),
        "amenities_index_keys": sorted((amenities_index or {}).keys()),
        "denoms_pa_fields": sorted(denoms_pa[0].keys()) if isinstance(denoms_pa, list) and denoms_pa else [],
        "denoms_sz_fields": sorted(denoms_sz[0].keys()) if isinstance(denoms_sz, list) and denoms_sz else [],
        "amenities_pa_fields": sorted(amenities_pa[0].keys()) if isinstance(amenities_pa, list) and amenities_pa else [],
        "amenities_sz_fields": sorted(amenities_sz[0].keys()) if isinstance(amenities_sz, list) and amenities_sz else [],
    }

    return {
        "row_counts": row_counts,
        "warnings": warnings,
        "errors": errors,
        "max_updated_at": max_updated_at,
        "latest_year": latest_year,
        "latest_snapshot": latest_snap,
        "schema_fingerprint": schema_fingerprint,
    }


def load_pipeline_log(path_value: str | None) -> str:
    if not path_value:
        return ""
    path = Path(path_value)
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return ""

def parse_json_arg(value: str | None, default: Any) -> Any:
    if value is None or value == "":
        return default
    text = value.strip()
    if text.startswith("@"):
        path = Path(text[1:])
        if not path.exists():
            return default
        text = path.read_text(encoding="utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return default


def parse_row_counts(values: list[str]) -> dict[str, int | float]:
    result: dict[str, int | float] = {}
    for item in values:
        if "=" not in item:
            continue
        key, raw = item.split("=", 1)
        key = key.strip()
        if not key:
            continue
        if raw.strip().isdigit():
            result[key] = int(raw.strip())
            continue
        try:
            result[key] = float(raw.strip())
        except ValueError:
            continue
    return result


def parse_artifacts(values: list[str]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for item in values:
        if "=" in item:
            label, url = item.split("=", 1)
            label = label.strip() or "artifact"
            url = url.strip()
        else:
            label = "artifact"
            url = item.strip()
        if url:
            result.append({"label": label, "url": url})
    return result


def normalize_checks(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, Any]] = []
    for row in value:
        if not isinstance(row, dict):
            continue
        status = str(row.get("status", "WARN")).upper()
        if status not in ALLOWED_STATUSES:
            status = "WARN"
        normalized.append(
            {
                "name": str(row.get("name", "check")),
                "status": status,
                "detail": str(row.get("detail", "")),
                **({"metric": row["metric"]} if "metric" in row else {}),
            }
        )
    return normalized


def add_check(
    checks: list[dict[str, Any]],
    name: str,
    status: str,
    detail: str,
    metric: Any | None = None,
) -> None:
    normalized_status = status.upper().strip()
    if normalized_status not in ALLOWED_STATUSES:
        normalized_status = "WARN"
    row: dict[str, Any] = {"name": name, "status": normalized_status, "detail": detail}
    if metric is not None:
        row["metric"] = metric
    checks.append(row)


def merge_checks(base: list[dict[str, Any]], extra: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered_names: list[str] = []
    by_name: dict[str, dict[str, Any]] = {}
    for row in base:
        name = str(row.get("name", "check"))
        if name not in by_name:
            ordered_names.append(name)
        by_name[name] = row
    for row in extra:
        name = str(row.get("name", "check"))
        if name not in by_name:
            ordered_names.append(name)
        by_name[name] = row
    return [by_name[name] for name in ordered_names]


def build_pipeline_checks(
    log_text: str,
    repo_state: dict[str, Any],
    *,
    denoms_due: bool,
    amenities_due: bool,
) -> tuple[list[dict[str, Any]], list[str]]:
    checks: list[dict[str, Any]] = []
    warnings: list[str] = []

    denoms_skipped = "Skip denoms: month=" in log_text
    denoms_no_new = "No new denom vintages found." in log_text
    amenities_skipped = "Skip amenities: month=" in log_text
    amenities_snapshot_exists = "Skip amenities: snapshot " in log_text

    singstat_discovery_fail = (
        "No respopagesexYYYY.ashx links found" in log_text
        or "Failed to fetch SingStat latest data page" in log_text
    )
    if singstat_discovery_fail:
        add_check(
            checks,
            "singstat_discovery",
            "FAIL",
            "SingStat discovery failed (page structure or upstream availability issue).",
        )
    elif "Discovered denominator years:" in log_text:
        match_line = re.search(r"Discovered denominator years:.*", log_text)
        years = re.findall(r"\d{4}", match_line.group(0)) if match_line else []
        add_check(checks, "singstat_discovery", "OK", "SingStat denominator links discovered.", {"years": len(years)})
    elif denoms_skipped and not denoms_due:
        add_check(checks, "singstat_discovery", "OK", "Denominator refresh not due this month.")
    elif denoms_no_new:
        status = "WARN" if denoms_due else "OK"
        add_check(checks, "singstat_discovery", status, "No new SingStat denominator vintage available.")
        if status == "WARN":
            warnings.append("Denominator due window active but no new SingStat vintage was published.")
    else:
        add_check(checks, "singstat_discovery", "WARN" if denoms_due else "OK", "No SingStat discovery signal in logs.")

    singstat_parse_fail = any(
        marker in log_text
        for marker in [
            "Failed to fetch zip for year=",
            "Could not find respopagesex CSV in ZIP",
            "Resident CSV header missing required columns",
            "Resident CSV appears empty",
        ]
    )
    if singstat_parse_fail:
        add_check(checks, "singstat_fetch_parse", "FAIL", "SingStat ZIP/CSV download or schema parse failed.")
    elif "Resident CSV parsed: rows=" in log_text:
        match = re.findall(r"Resident CSV parsed: rows=(\d+), dropped=(\d+)", log_text)
        metric = None
        if match:
            rows, dropped = match[-1]
            metric = {"rows": int(rows), "dropped": int(dropped)}
        add_check(checks, "singstat_fetch_parse", "OK", "SingStat ZIP/CSV parse succeeded.", metric)
    elif denoms_skipped and not denoms_due:
        add_check(checks, "singstat_fetch_parse", "OK", "Denominator fetch/parse not due this month.")
    elif denoms_no_new:
        add_check(
            checks,
            "singstat_fetch_parse",
            "WARN" if denoms_due else "OK",
            "No new SingStat vintage to fetch and parse.",
        )
    else:
        add_check(checks, "singstat_fetch_parse", "WARN" if denoms_due else "OK", "No SingStat parse signal in logs.")

    datagov_fail = "data.gov.sg API failed" in log_text or "data.gov.sg API returned unsuccessful payload" in log_text
    if datagov_fail:
        add_check(checks, "moe_datagov_fetch", "FAIL", "data.gov.sg datastore request failed.")
    elif "MOE schools points:" in log_text:
        add_check(checks, "moe_datagov_fetch", "OK", "MOE datastore fetch succeeded.")
    elif amenities_skipped and not amenities_due:
        add_check(checks, "moe_datagov_fetch", "OK", "Amenities refresh not due this month.")
    elif amenities_snapshot_exists and not amenities_due:
        add_check(checks, "moe_datagov_fetch", "OK", "Amenity snapshot already exists; fetch skipped.")
    else:
        add_check(checks, "moe_datagov_fetch", "WARN" if amenities_due else "OK", "No MOE datastore fetch signal in logs.")

    onemap_fail = any(
        marker in log_text
        for marker in [
            "Missing OneMap credentials",
            "OneMap auth failed",
            "OneMap geocode failed for",
            "OneMap geocode auth failed repeatedly",
        ]
    )
    if onemap_fail:
        add_check(checks, "onemap_auth_geocode", "FAIL", "OneMap auth/geocoding failed.")
    else:
        geocode_match = re.search(
            r"OneMap geocode stats:\s*eligible=(\d+),\s*resolved=(\d+),\s*unresolved=(\d+),\s*rate=([0-9]*\.?[0-9]+)",
            log_text,
        )
        if geocode_match:
            eligible = int(geocode_match.group(1))
            resolved = int(geocode_match.group(2))
            unresolved = int(geocode_match.group(3))
            rate = float(geocode_match.group(4))
            status = "OK" if rate >= 0.9 else "WARN"
            add_check(
                checks,
                "onemap_auth_geocode",
                status,
                "OneMap auth/geocode completed with measured success rate.",
                {
                    "eligible": eligible,
                    "resolved": resolved,
                    "unresolved": unresolved,
                    "success_rate": rate,
                },
            )
            if status == "WARN":
                warnings.append(f"OneMap geocode success rate is low ({resolved}/{eligible}, rate={rate:.3f}).")
        elif amenities_skipped and not amenities_due:
            add_check(checks, "onemap_auth_geocode", "OK", "OneMap geocoding not due this month.")
        else:
            add_check(checks, "onemap_auth_geocode", "WARN" if amenities_due else "OK", "No OneMap auth/geocode signal in logs.")

    overpass_fail = "Overpass failed for category" in log_text or bool(
        re.search(r"Overpass HTTP \d+ for .* @ https?://", log_text)
    )
    if overpass_fail:
        add_check(checks, "overpass_fetch", "FAIL", "Overpass failed after endpoint retries/failover.")
    else:
        category_rows = list(
            re.finditer(r"([a-z_]+)\s+\(OSM\):\s*total=(\d+),\s*assigned=(\d+),\s*unassigned=(\d+)", log_text)
        )
        retries = len(re.findall(r"Overpass HTTP (?:429|502|503|504)", log_text)) + len(
            re.findall(r"Overpass error \(", log_text)
        )
        switches = len(re.findall(r"Switching Overpass endpoint after failures", log_text))
        if category_rows:
            found = {m.group(1) for m in category_rows}
            missing = sorted(OSM_CATEGORIES - found)
            if missing:
                add_check(
                    checks,
                    "overpass_fetch",
                    "WARN",
                    f"Overpass completed with missing category signals: {', '.join(missing)}.",
                    {"categories_found": sorted(found), "retries": retries, "endpoint_switches": switches},
                )
                warnings.append(f"Overpass category coverage incomplete: missing {', '.join(missing)}.")
            elif retries > 0 or switches > 0:
                add_check(
                    checks,
                    "overpass_fetch",
                    "WARN",
                    "Overpass completed after retries/failover.",
                    {"categories_found": sorted(found), "retries": retries, "endpoint_switches": switches},
                )
                warnings.append("Overpass endpoint instability observed (retries/failover occurred).")
            else:
                add_check(checks, "overpass_fetch", "OK", "Overpass fetch succeeded across OSM categories.")
        elif amenities_skipped and not amenities_due:
            add_check(checks, "overpass_fetch", "OK", "Overpass fetch not due this month.")
        else:
            add_check(checks, "overpass_fetch", "WARN" if amenities_due else "OK", "No Overpass fetch signal in logs.")

    denom_test_fail = "Denominator sanity check failed" in log_text or "Missing denominator outputs for year=" in log_text
    if denom_test_fail:
        add_check(checks, "denom_tests", "FAIL", "Denominator tests failed.")
    elif "Denominator tests passed for" in log_text:
        add_check(checks, "denom_tests", "OK", "Denominator tests passed.")
    elif denoms_skipped and not denoms_due:
        add_check(checks, "denom_tests", "OK", "Denominator tests skipped because refresh is not due.")
    elif denoms_no_new:
        add_check(
            checks,
            "denom_tests",
            "WARN" if denoms_due else "OK",
            "Denominator tests did not run because no new denominator vintage was available.",
        )
    else:
        add_check(checks, "denom_tests", "WARN" if denoms_due else "OK", "No denominator test signal in logs.")

    amenity_test_fail = "Amenity sanity check failed" in log_text or "Amenity test failed." in log_text
    if amenity_test_fail:
        add_check(checks, "amenity_tests", "FAIL", "Amenity tests failed.")
    elif "Amenity tests passed for" in log_text:
        add_check(checks, "amenity_tests", "OK", "Amenity tests passed.")
    elif amenities_skipped and not amenities_due:
        add_check(checks, "amenity_tests", "OK", "Amenity tests skipped because refresh is not due.")
    elif amenities_snapshot_exists and not amenities_due:
        add_check(checks, "amenity_tests", "OK", "Amenity snapshot already existed.")
    else:
        add_check(checks, "amenity_tests", "WARN" if amenities_due else "OK", "No amenity test signal in logs.")

    if repo_state["errors"]:
        add_check(
            checks,
            "output_write",
            "FAIL",
            "Missing or malformed output JSON files.",
            {"errors": repo_state["errors"][:5]},
        )
        warnings.extend(repo_state["errors"][:5])
    elif repo_state["warnings"]:
        add_check(
            checks,
            "output_write",
            "WARN",
            "Output files are present but there are non-critical quality issues.",
            {"warnings": repo_state["warnings"][:5]},
        )
        warnings.extend(repo_state["warnings"][:5])
    else:
        add_check(checks, "output_write", "OK", "Output files written and readable.")

    if denoms_due and denoms_no_new:
        warnings.append("Denominator due window active but no new source data was published.")
    if amenities_due and amenities_snapshot_exists and "Amenity snapshot written:" not in log_text:
        warnings.append("Amenity due window active but snapshot already existed; no fresh write occurred.")

    return checks, warnings


def derive_status(
    *,
    base_status: str,
    pipeline_outcome: str | None,
    key_checks: list[dict[str, Any]],
    warnings: list[str],
) -> str:
    normalized = base_status.upper().strip()
    if normalized not in ALLOWED_STATUSES:
        normalized = "WARN"
    outcome = str(pipeline_outcome or "").strip().lower()
    if outcome in {"failure", "cancelled", "timed_out", "skipped"}:
        return "FAIL"
    if normalized == "FAIL":
        return "FAIL"
    if any(str(check.get("status", "")).upper() == "FAIL" for check in key_checks):
        return "FAIL"
    if normalized == "WARN":
        return "WARN"
    if warnings or any(str(check.get("status", "")).upper() == "WARN" for check in key_checks):
        return "WARN"
    return "OK"


def schema_hash(
    schema_path: str | None,
    explicit_hash: str | None,
    auto_fingerprint: dict[str, Any] | None = None,
) -> str | None:
    if explicit_hash:
        return explicit_hash.strip() or None
    if schema_path:
        file = Path(schema_path)
        if file.exists():
            return hashlib.sha256(file.read_bytes()).hexdigest()
    if not auto_fingerprint:
        return None
    digest = hashlib.sha256(
        json.dumps(auto_fingerprint, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return digest


def run_metadata() -> dict[str, Any]:
    repo = os.environ.get("GITHUB_REPOSITORY")
    run_id = os.environ.get("GITHUB_RUN_ID")
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    run_url = f"{server}/{repo}/actions/runs/{run_id}" if repo and run_id else None
    return {
        "repo": repo,
        "run_id": run_id,
        "run_url": run_url,
        "workflow": os.environ.get("GITHUB_WORKFLOW"),
        "job": os.environ.get("GITHUB_JOB"),
        "sha": os.environ.get("GITHUB_SHA"),
    }


def build_artifact_links(args: argparse.Namespace, meta: dict[str, Any]) -> list[dict[str, str]]:
    artifacts = parse_artifacts(args.artifact)
    artifacts.extend(parse_json_arg(args.artifacts_json, []) if args.artifacts_json else [])
    normalized: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for item in artifacts:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label", "artifact")).strip() or "artifact"
        url = str(item.get("url", "")).strip()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        normalized.append({"label": label, "url": url})

    run_url = str(meta.get("run_url") or "").strip()
    if run_url and run_url not in seen_urls:
        seen_urls.add(run_url)
        normalized.append({"label": "workflow_run", "url": run_url})

    repo = str(meta.get("repo") or "").strip()
    sha = str(meta.get("sha") or "").strip()
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
    if repo and sha:
        for label, rel_path in [
            ("denoms_index", "web/data/denoms_index.json"),
            ("amenities_index", "web/data/amenities_index.json"),
            ("ops_probe", "ops/probe.json"),
        ]:
            url = f"{server}/{repo}/blob/{sha}/{rel_path}"
            if url in seen_urls:
                continue
            seen_urls.add(url)
            normalized.append({"label": label, "url": url})

    return normalized


def build_probe(args: argparse.Namespace) -> dict[str, Any]:
    current = now_utc()
    end = parse_dt(args.end_time) or current
    last_run = parse_dt(args.last_run_time) or end
    start = parse_dt(args.start_time)

    duration = to_float(args.duration_seconds)
    if duration is None and start is not None:
        duration = max(0.0, (end - start).total_seconds())

    base_status = str(args.status or "OK").upper().strip()
    if base_status not in ALLOWED_STATUSES:
        base_status = "WARN"

    repo_state = collect_repo_state(Path.cwd())
    log_text = load_pipeline_log(args.pipeline_log)
    run_month = month_in_timezone(last_run, "Asia/Singapore")
    denoms_due = (
        parse_bool(args.force_denoms)
        or bool(str(args.target_year or "").strip())
        or run_month in DENOM_CHECK_MONTHS
    )
    amenities_due = (
        parse_bool(args.force_amenities)
        or bool(str(args.target_snapshot or "").strip())
        or run_month in AMENITY_CHECK_MONTHS
    )

    key_checks, computed_warnings = build_pipeline_checks(
        log_text, repo_state, denoms_due=denoms_due, amenities_due=amenities_due
    )
    key_checks = merge_checks(key_checks, normalize_checks(parse_json_arg(args.key_checks_json, [])))

    warnings = list(computed_warnings)
    warnings.extend(item for item in args.warning if str(item).strip())
    warnings.extend(parse_json_arg(args.warnings_json, []) if args.warnings_json else [])
    warnings = dedupe_strings(warnings)

    row_counts = dict(repo_state["row_counts"])
    row_counts.update(parse_row_counts(args.row_count))

    max_date_value = args.max_date or iso_utc(repo_state.get("max_updated_at"))
    max_dt = parse_dt(max_date_value)
    lag_seconds = max(0.0, (current - max_dt).total_seconds()) if max_dt else None
    stale_after = int(args.stale_after_seconds or DEFAULT_STALE_AFTER_SECONDS)
    stale = lag_seconds is not None and lag_seconds > stale_after
    if stale:
        warnings = dedupe_strings(
            warnings + [f"Data freshness lag is high ({int(lag_seconds)}s > {stale_after}s threshold)."]
        )
    if max_dt is None:
        warnings = dedupe_strings(warnings + ["Freshness max_date is unavailable from index files."])

    status = derive_status(
        base_status=base_status,
        pipeline_outcome=args.pipeline_outcome,
        key_checks=key_checks,
        warnings=warnings,
    )

    meta = run_metadata()
    normalized_artifacts = build_artifact_links(args, meta)

    probe = {
        "schema_version": "1.0",
        "status": status,
        "last_run_time": iso_utc(last_run),
        "duration_seconds": duration,
        "freshness": {
            "max_date": max_date_value,
            "lag_seconds": lag_seconds,
            "stale": bool(stale) if max_dt else None,
        },
        "row_counts": row_counts,
        "schema_hash": schema_hash(args.schema_file, args.schema_hash, repo_state.get("schema_fingerprint")),
        "key_checks": key_checks,
        "warnings": warnings,
        "artifact_links": normalized_artifacts,
        "meta": meta,
    }
    return probe


def write_probe(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit standardized ops/probe.json.")
    parser.add_argument("--output", default="ops/probe.json")
    parser.add_argument("--status", default="OK")
    parser.add_argument("--last-run-time")
    parser.add_argument("--start-time")
    parser.add_argument("--end-time")
    parser.add_argument("--duration-seconds")
    parser.add_argument("--max-date")
    parser.add_argument("--schema-file")
    parser.add_argument("--schema-hash")
    parser.add_argument("--row-count", action="append", default=[], help="name=value")
    parser.add_argument("--warning", action="append", default=[])
    parser.add_argument("--warnings-json")
    parser.add_argument("--key-checks-json", help="JSON string or @path to JSON file")
    parser.add_argument("--artifact", action="append", default=[], help="label=url")
    parser.add_argument("--artifacts-json")
    parser.add_argument("--pipeline-log", help="Path to captured pipeline log")
    parser.add_argument("--pipeline-outcome", help="GitHub step outcome for the pipeline step")
    parser.add_argument("--force-denoms", default="false")
    parser.add_argument("--force-amenities", default="false")
    parser.add_argument("--target-year", default="")
    parser.add_argument("--target-snapshot", default="")
    parser.add_argument("--stale-after-seconds", type=int, default=DEFAULT_STALE_AFTER_SECONDS)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    output_path = Path(args.output)
    try:
        probe = build_probe(args)
        write_probe(output_path, probe)
        print(f"Wrote probe: {output_path}")
        return 0
    except Exception as exc:
        if args.strict:
            raise
        fallback = {
            "schema_version": "1.0",
            "status": "FAIL",
            "last_run_time": iso_utc(now_utc()),
            "duration_seconds": None,
            "freshness": {"max_date": None, "lag_seconds": None, "stale": None},
            "row_counts": {},
            "schema_hash": None,
            "key_checks": [],
            "warnings": [f"Probe emitter failed: {exc}"],
            "artifact_links": [],
            "meta": run_metadata(),
        }
        run_url = fallback["meta"].get("run_url")
        if run_url:
            fallback["artifact_links"].append({"label": "workflow_run", "url": run_url})
        write_probe(output_path, fallback)
        print(f"Emitter error ignored (non-blocking): {exc}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
