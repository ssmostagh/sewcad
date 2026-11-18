#!/usr/bin/env python3
"""Independent physical 1:1 export validator for SVG, Tiled PDF 1.4, and CAD DXF.

Accepts:
  --format svg|pdf|dxf
  --file <path>
  [--expectations <json_path>]

Outputs JSON to stdout:
  { "ok": bool, "errors": [...], "metrics": {...} }
Exit code 0 if ok else 1.
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Optional, Tuple

import lxml.etree as ET
import numpy as np

UNIT_TO_MM = {
    "mm": 1.0,
    "cm": 10.0,
    "in": 25.4,
    "pt": 25.4 / 72.0,
    "pc": 25.4 / 6.0,
    "px": 25.4 / 96.0,
    "": 1.0,
}

PAGE_SIZES_PT = {
    "LETTER": (612.0, 792.0),
    "A4": (595.28, 841.89),
    "A0": (2383.94, 3370.39),
}

FLOAT_CMP_EPS = 1e-9

SKIP_SVG_TAGS = {
    "defs",
    "symbol",
    "clipPath",
    "mask",
    "pattern",
    "title",
    "desc",
    "metadata",
    "style",
    "script",
}

PATH_TOKEN_RE = re.compile(
    r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[a-zA-Z]"
)
TRANSFORM_FN_RE = re.compile(r"([a-zA-Z]+)\s*\(([^)]*)\)")
NUM_RE = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
LEN_RE = re.compile(r"^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$")


def local_tag(tag: Any) -> str:
    if not isinstance(tag, str):
        return ""
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def parse_length_mm(val: Optional[str]) -> Tuple[Optional[float], str]:
    if not val:
        return None, ""
    m = LEN_RE.match(val)
    if not m:
        return None, ""
    num = float(m.group(1))
    unit = m.group(2).lower()
    if unit not in UNIT_TO_MM:
        return None, unit
    return num * UNIT_TO_MM[unit], unit


def parse_transform_attr(attr: Optional[str]) -> np.ndarray:
    mat = np.eye(3, dtype=np.float64)
    if not attr:
        return mat
    for fn, args_str in TRANSFORM_FN_RE.findall(attr):
        nums = [float(x) for x in NUM_RE.findall(args_str)]
        m = np.eye(3, dtype=np.float64)
        fn_l = fn.lower()
        if fn_l == "matrix" and len(nums) >= 6:
            a, b, c, d, e, f = nums[:6]
            m = np.array([[a, c, e], [b, d, f], [0.0, 0.0, 1.0]], dtype=np.float64)
        elif fn_l == "translate" and len(nums) >= 1:
            tx = nums[0]
            ty = nums[1] if len(nums) >= 2 else 0.0
            m = np.array([[1.0, 0.0, tx], [0.0, 1.0, ty], [0.0, 0.0, 1.0]], dtype=np.float64)
        elif fn_l == "scale" and len(nums) >= 1:
            sx = nums[0]
            sy = nums[1] if len(nums) >= 2 else sx
            m = np.array([[sx, 0.0, 0.0], [0.0, sy, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
        elif fn_l == "rotate" and len(nums) >= 1:
            ang = math.radians(nums[0])
            ca, sa = math.cos(ang), math.sin(ang)
            r = np.array([[ca, -sa, 0.0], [sa, ca, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
            if len(nums) >= 3:
                cx, cy = nums[1], nums[2]
                t1 = np.array([[1.0, 0.0, cx], [0.0, 1.0, cy], [0.0, 0.0, 1.0]], dtype=np.float64)
                t2 = np.array([[1.0, 0.0, -cx], [0.0, 1.0, -cy], [0.0, 0.0, 1.0]], dtype=np.float64)
                m = t1 @ r @ t2
            else:
                m = r
        elif fn_l == "skewx" and len(nums) >= 1:
            t = math.tan(math.radians(nums[0]))
            m = np.array([[1.0, t, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
        elif fn_l == "skewy" and len(nums) >= 1:
            t = math.tan(math.radians(nums[0]))
            m = np.array([[1.0, 0.0, 0.0], [t, 1.0, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
        mat = mat @ m
    return mat


def apply_matrix(mat: np.ndarray, pts: List[Tuple[float, float]], scale: float = 1.0) -> List[Tuple[float, float]]:
    if not pts:
        return []
    arr = np.asarray(pts, dtype=np.float64)
    ones = np.ones((arr.shape[0], 1), dtype=np.float64)
    hom = np.hstack([arr, ones])
    out = (mat @ hom.T).T[:, :2] * scale
    return [(float(x), float(y)) for x, y in out]


def sample_cubic(
    p0: Tuple[float, float],
    p1: Tuple[float, float],
    p2: Tuple[float, float],
    p3: Tuple[float, float],
    coord_scale: float = 1.0,
) -> List[Tuple[float, float]]:
    scale = max(float(coord_scale), 1e-9)
    chord = math.hypot(p3[0] - p0[0], p3[1] - p0[1]) * scale
    ctrl_len = (
        math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        + math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        + math.hypot(p3[0] - p2[0], p3[1] - p2[1])
    ) * scale
    dd1 = math.hypot(p2[0] - 2.0 * p1[0] + p0[0], p2[1] - 2.0 * p1[1] + p0[1]) * scale
    dd2 = math.hypot(p3[0] - 2.0 * p2[0] + p1[0], p3[1] - 2.0 * p2[1] + p1[1]) * scale
    dmax = max(dd1, dd2)
    flatness_steps = math.ceil(math.sqrt((3.0 * dmax) / (4.0 * 0.005))) if dmax > 1e-9 else 32
    steps = max(32, min(4096, max(flatness_steps, min(256, int(max(chord, ctrl_len) * 0.5) + 32))))
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1.0 - t
        mt2 = mt * mt
        t2 = t * t
        x = mt2 * mt * p0[0] + 3.0 * mt2 * t * p1[0] + 3.0 * mt * t2 * p2[0] + t2 * t * p3[0]
        y = mt2 * mt * p0[1] + 3.0 * mt2 * t * p1[1] + 3.0 * mt * t2 * p2[1] + t2 * t * p3[1]
        pts.append((x, y))
    return pts


def sample_quad(
    p0: Tuple[float, float],
    p1: Tuple[float, float],
    p2: Tuple[float, float],
    coord_scale: float = 1.0,
) -> List[Tuple[float, float]]:
    scale = max(float(coord_scale), 1e-9)
    chord = math.hypot(p2[0] - p0[0], p2[1] - p0[1]) * scale
    ctrl_len = (
        math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        + math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    ) * scale
    dd = math.hypot(p2[0] - 2.0 * p1[0] + p0[0], p2[1] - 2.0 * p1[1] + p0[1]) * scale
    flatness_steps = math.ceil(math.sqrt(dd / (4.0 * 0.005))) if dd > 1e-9 else 32
    steps = max(32, min(4096, max(flatness_steps, min(256, int(max(chord, ctrl_len) * 0.5) + 32))))
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1.0 - t
        x = mt * mt * p0[0] + 2.0 * mt * t * p1[0] + t * t * p2[0]
        y = mt * mt * p0[1] + 2.0 * mt * t * p1[1] + t * t * p2[1]
        pts.append((x, y))
    return pts


def adaptive_arc_steps(
    max_radius_mm: float,
    sweep_rad: float,
    min_steps: int = 32,
    max_steps: int = 4096,
    sagitta_mm: float = 0.01,
) -> int:
    max_r = max(float(max_radius_mm), 1.0)
    cos_lim = max(1.0 - float(sagitta_mm) / max_r, -1.0)
    step_ang = 2.0 * math.acos(cos_lim) if cos_lim < 1.0 - 1e-12 else 1e-6
    return max(min_steps, min(max_steps, math.ceil(abs(sweep_rad) / step_ang)))


def sample_svg_arc(
    p0: Tuple[float, float],
    rx: float,
    ry: float,
    x_axis_rot_deg: float,
    large_arc: int,
    sweep: int,
    p1: Tuple[float, float],
    steps: Optional[int] = None,
    coord_scale: float = 1.0,
) -> List[Tuple[float, float]]:
    x1, y1 = p0
    x2, y2 = p1
    if math.hypot(x2 - x1, y2 - y1) < 1e-9:
        return [p1]
    if abs(rx) < 1e-9 or abs(ry) < 1e-9:
        return [p1]
    rx, ry = abs(rx), abs(ry)
    phi = math.radians(x_axis_rot_deg)
    cosphi, sinphi = math.cos(phi), math.sin(phi)
    dx2 = (x1 - x2) * 0.5
    dy2 = (y1 - y2) * 0.5
    x1p = cosphi * dx2 + sinphi * dy2
    y1p = -sinphi * dx2 + cosphi * dy2

    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1.0:
        s = math.sqrt(lam)
        rx *= s
        ry *= s

    rx2, ry2 = rx * rx, ry * ry
    x1p2, y1p2 = x1p * x1p, y1p * y1p
    num = max(0.0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2)
    den = rx2 * y1p2 + ry2 * x1p2
    factor = math.sqrt(num / den) if den > 1e-12 else 0.0
    if large_arc == sweep:
        factor = -factor
    cxp = factor * (rx * y1p) / ry
    cyp = factor * (-ry * x1p) / rx

    cx = cosphi * cxp - sinphi * cyp + (x1 + x2) * 0.5
    cy = sinphi * cxp + cosphi * cyp + (y1 + y2) * 0.5

    def vec_angle(ux: float, uy: float, vx: float, vy: float) -> float:
        dot = ux * vx + uy * vy
        det = ux * vy - uy * vx
        return math.atan2(det, dot)

    theta1 = vec_angle(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dtheta = vec_angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if sweep == 0 and dtheta > 0:
        dtheta -= 2.0 * math.pi
    elif sweep == 1 and dtheta < 0:
        dtheta += 2.0 * math.pi

    if steps is None:
        steps = adaptive_arc_steps(max(rx, ry) * max(float(coord_scale), 1e-9), dtheta, min_steps=32, max_steps=4096)

    pts = []
    for i in range(1, steps + 1):
        ang = theta1 + dtheta * (i / steps)
        ca, sa = math.cos(ang), math.sin(ang)
        x = cx + cosphi * rx * ca - sinphi * ry * sa
        y = cy + sinphi * rx * ca + cosphi * ry * sa
        pts.append((x, y))
    return pts


def parse_svg_path_d(d_str: str, coord_scale: float = 1.0) -> List[Tuple[List[Tuple[float, float]], bool]]:
    tokens = PATH_TOKEN_RE.findall(d_str or "")
    idx = 0
    n = len(tokens)
    cur = (0.0, 0.0)
    sub_start = (0.0, 0.0)
    last_ctrl: Optional[Tuple[float, float]] = None
    last_cmd = ""
    cmd = ""
    subpaths: List[Tuple[List[Tuple[float, float]], bool]] = []
    cur_pts: List[Tuple[float, float]] = []

    def is_num(tok: str) -> bool:
        return not (len(tok) == 1 and tok.isalpha())

    def next_float() -> float:
        nonlocal idx
        val = float(tokens[idx])
        idx += 1
        return val

    def next_flag() -> int:
        nonlocal idx
        tok = tokens[idx]
        if len(tok) > 1 and tok[0] in ("0", "1"):
            tokens[idx] = tok[1:]
            return int(tok[0])
        idx += 1
        return int(float(tok))

    def flush_subpath(closed: bool) -> None:
        nonlocal cur_pts
        # Drop empty or M-only subpaths
        if len(cur_pts) >= 2:
            # Check if there are at least 2 distinct points
            distinct = any(
                math.hypot(p[0] - cur_pts[0][0], p[1] - cur_pts[0][1]) > 1e-6
                for p in cur_pts[1:]
            )
            if distinct:
                subpaths.append((cur_pts, closed))
        cur_pts = []

    while idx < n:
        if tokens[idx].isalpha():
            cmd = tokens[idx]
            idx += 1
            if cmd in ("Z", "z"):
                if cur_pts:
                    if math.hypot(cur[0] - sub_start[0], cur[1] - sub_start[1]) > 1e-6:
                        cur_pts.append(sub_start)
                    flush_subpath(True)
                cur = sub_start
                last_ctrl = None
                last_cmd = cmd
                continue
        else:
            if not cmd:
                break
            if cmd == "M":
                cmd = "L"
            elif cmd == "m":
                cmd = "l"

        if cmd in ("M", "m"):
            flush_subpath(False)
            x, y = next_float(), next_float()
            if cmd == "m":
                x += cur[0]
                y += cur[1]
            cur = (x, y)
            sub_start = cur
            cur_pts = [cur]
            last_ctrl = None
            last_cmd = cmd
            # Subsequent pairs are implicit L/l
            cmd = "L" if cmd == "M" else "l"
        elif cmd in ("L", "l"):
            if idx + 1 >= n or not is_num(tokens[idx]):
                break
            x, y = next_float(), next_float()
            if cmd == "l":
                x += cur[0]
                y += cur[1]
            cur = (x, y)
            if not cur_pts:
                cur_pts = [sub_start]
            cur_pts.append(cur)
            last_ctrl = None
            last_cmd = cmd
        elif cmd in ("H", "h"):
            x = next_float()
            if cmd == "h":
                x += cur[0]
            cur = (x, cur[1])
            if not cur_pts:
                cur_pts = [sub_start]
            cur_pts.append(cur)
            last_ctrl = None
            last_cmd = cmd
        elif cmd in ("V", "v"):
            y = next_float()
            if cmd == "v":
                y += cur[1]
            cur = (cur[0], y)
            if not cur_pts:
                cur_pts = [sub_start]
            cur_pts.append(cur)
            last_ctrl = None
            last_cmd = cmd
        elif cmd in ("C", "c"):
            x1, y1, x2, y2, x, y = (
                next_float(), next_float(), next_float(), next_float(), next_float(), next_float()
            )
            if cmd == "c":
                x1 += cur[0]; y1 += cur[1]
                x2 += cur[0]; y2 += cur[1]
                x += cur[0]; y += cur[1]
            if not cur_pts:
                cur_pts = [cur]
            cur_pts.extend(sample_cubic(cur, (x1, y1), (x2, y2), (x, y), coord_scale=coord_scale))
            last_ctrl = (x2, y2)
            cur = (x, y)
            last_cmd = cmd
        elif cmd in ("S", "s"):
            x2, y2, x, y = next_float(), next_float(), next_float(), next_float()
            if cmd == "s":
                x2 += cur[0]; y2 += cur[1]
                x += cur[0]; y += cur[1]
            if last_cmd in ("C", "c", "S", "s") and last_ctrl is not None:
                x1 = 2.0 * cur[0] - last_ctrl[0]
                y1 = 2.0 * cur[1] - last_ctrl[1]
            else:
                x1, y1 = cur
            if not cur_pts:
                cur_pts = [cur]
            cur_pts.extend(sample_cubic(cur, (x1, y1), (x2, y2), (x, y), coord_scale=coord_scale))
            last_ctrl = (x2, y2)
            cur = (x, y)
            last_cmd = cmd
        elif cmd in ("Q", "q"):
            x1, y1, x, y = next_float(), next_float(), next_float(), next_float()
            if cmd == "q":
                x1 += cur[0]; y1 += cur[1]
                x += cur[0]; y += cur[1]
            if not cur_pts:
                cur_pts = [cur]
            cur_pts.extend(sample_quad(cur, (x1, y1), (x, y), coord_scale=coord_scale))
            last_ctrl = (x1, y1)
            cur = (x, y)
            last_cmd = cmd
        elif cmd in ("T", "t"):
            x, y = next_float(), next_float()
            if cmd == "t":
                x += cur[0]; y += cur[1]
            if last_cmd in ("Q", "q", "T", "t") and last_ctrl is not None:
                x1 = 2.0 * cur[0] - last_ctrl[0]
                y1 = 2.0 * cur[1] - last_ctrl[1]
            else:
                x1, y1 = cur
            if not cur_pts:
                cur_pts = [cur]
            cur_pts.extend(sample_quad(cur, (x1, y1), (x, y), coord_scale=coord_scale))
            last_ctrl = (x1, y1)
            cur = (x, y)
            last_cmd = cmd
        elif cmd in ("A", "a"):
            rx, ry, rot = next_float(), next_float(), next_float()
            large_arc = next_flag()
            sweep = next_flag()
            x, y = next_float(), next_float()
            if cmd == "a":
                x += cur[0]; y += cur[1]
            if not cur_pts:
                cur_pts = [cur]
            cur_pts.extend(sample_svg_arc(cur, rx, ry, rot, large_arc, sweep, (x, y), coord_scale=coord_scale))
            cur = (x, y)
            last_ctrl = None
            last_cmd = cmd
        else:
            break

    flush_subpath(False)
    return subpaths


def polygon_metrics(pts: List[Tuple[float, float]], closed: bool) -> Dict[str, Any]:
    clean = list(pts)
    if closed and len(clean) >= 2 and math.hypot(clean[0][0] - clean[-1][0], clean[0][1] - clean[-1][1]) < 1e-6:
        clean = clean[:-1]
    xs = [p[0] for p in clean] if clean else [0.0]
    ys = [p[1] for p in clean] if clean else [0.0]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    width = max_x - min_x
    height = max_y - min_y

    perim = 0.0
    for i in range(len(clean) - 1):
        perim += math.hypot(clean[i + 1][0] - clean[i][0], clean[i + 1][1] - clean[i][1])
    if closed and len(clean) >= 3:
        perim += math.hypot(clean[0][0] - clean[-1][0], clean[0][1] - clean[-1][1])

    signed_area = 0.0
    if closed and len(clean) >= 3:
        for i in range(len(clean)):
            x0, y0 = clean[i]
            x1, y1 = clean[(i + 1) % len(clean)]
            signed_area += x0 * y1 - x1 * y0
        signed_area *= 0.5

    return {
        "points": clean,
        "vertexCount": len(clean),
        "closed": bool(closed and len(clean) >= 3),
        "minX": min_x,
        "minY": min_y,
        "maxX": max_x,
        "maxY": max_y,
        "widthMm": width,
        "heightMm": height,
        "perimeterMm": perim,
        "signedAreaMm2": signed_area,
        "areaMm2": abs(signed_area),
    }


def parse_svg_inline_style(style_attr: Optional[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not style_attr:
        return out
    for decl in style_attr.split(";"):
        if ":" not in decl:
            continue
        k, v = decl.split(":", 1)
        k = k.strip().lower()
        v = v.strip()
        if k:
            out[k] = v
    return out


def resolve_svg_element_layer(elem: ET._Element, tag: str, cur_layer: str) -> str:
    data_layer = (elem.get("data-layer") or "").strip()
    if data_layer:
        return data_layer
    if tag in ("svg", "page"):
        return cur_layer
    elem_id = (elem.get("id") or "").strip()
    elem_class = (elem.get("class") or "").strip()
    if tag == "g":
        if elem_id and is_semantic_svg_layer(elem_id):
            return elem_id
        if elem_class and is_semantic_svg_layer(elem_class):
            return elem_class
        if is_semantic_svg_layer(cur_layer):
            return cur_layer
        return elem_id or elem_class or cur_layer
    if is_semantic_svg_layer(cur_layer):
        return cur_layer
    if elem_id and is_semantic_svg_layer(elem_id):
        return elem_id
    if elem_class and is_semantic_svg_layer(elem_class):
        return elem_class
    return elem_id or elem_class or cur_layer


def extract_svg_elements_geometry(
    root_elem: ET._Element,
    coord_scale: float = 1.0,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    shapes: List[Dict[str, Any]] = []
    layers: List[str] = []

    def walk(
        elem: ET._Element,
        cur_mat: np.ndarray,
        cur_layer: str,
        cur_stroke: Optional[str],
        cur_fill: Optional[str],
        cur_dash: str,
    ) -> None:
        tag = local_tag(elem.tag)
        if tag in SKIP_SVG_TAGS:
            return

        mat = cur_mat @ parse_transform_attr(elem.get("transform"))
        layer_id = resolve_svg_element_layer(elem, tag, cur_layer)
        if tag == "g" and layer_id:
            layers.append(layer_id)

        style_map = parse_svg_inline_style(elem.get("style"))
        dash_attr = style_map.get("stroke-dasharray")
        if dash_attr is None:
            dash_attr = elem.get("stroke-dasharray")
        eff_dash = dash_attr.strip() if dash_attr is not None else cur_dash
        is_dashed = bool(eff_dash and eff_dash.lower() != "none")

        stroke = style_map.get("stroke")
        if stroke is None:
            stroke = elem.get("stroke")
        if stroke is None:
            stroke = cur_stroke

        fill = style_map.get("fill")
        if fill is None:
            fill = elem.get("fill")
        if fill is None:
            fill = cur_fill

        extracted: List[Tuple[List[Tuple[float, float]], bool]] = []

        if tag == "path":
            a11 = float(mat[0, 0]) * coord_scale
            a21 = float(mat[1, 0]) * coord_scale
            a12 = float(mat[0, 1]) * coord_scale
            a22 = float(mat[1, 1]) * coord_scale
            s1 = a11 * a11 + a21 * a21
            s2 = a12 * a12 + a22 * a22
            dot = a11 * a12 + a21 * a22
            eff_scale = math.sqrt(max(0.0, 0.5 * (s1 + s2 + math.hypot(s1 - s2, 2.0 * dot))))
            extracted = parse_svg_path_d(elem.get("d") or "", coord_scale=max(eff_scale, 1e-9))
        elif tag == "rect":
            x = float(elem.get("x") or 0.0)
            y = float(elem.get("y") or 0.0)
            rw = float(elem.get("width") or 0.0)
            rh = float(elem.get("height") or 0.0)
            if rw > 0 and rh > 0:
                extracted = [([(x, y), (x + rw, y), (x + rw, y + rh), (x, y + rh), (x, y)], True)]
        elif tag == "line":
            x1 = float(elem.get("x1") or 0.0)
            y1 = float(elem.get("y1") or 0.0)
            x2 = float(elem.get("x2") or 0.0)
            y2 = float(elem.get("y2") or 0.0)
            extracted = [([(x1, y1), (x2, y2)], False)]
        elif tag in ("polyline", "polygon"):
            nums = [float(v) for v in NUM_RE.findall(elem.get("points") or "")]
            pts = [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
            if len(pts) >= 2:
                extracted = [(pts, tag == "polygon")]
        elif tag == "circle":
            cx = float(elem.get("cx") or 0.0)
            cy = float(elem.get("cy") or 0.0)
            r = float(elem.get("r") or 0.0)
            if r > 0:
                sx_eff = math.hypot(mat[0, 0], mat[1, 0]) * coord_scale
                sy_eff = math.hypot(mat[0, 1], mat[1, 1]) * coord_scale
                steps = adaptive_arc_steps(
                    r * max(sx_eff, sy_eff, 1e-9),
                    2.0 * math.pi,
                    min_steps=64,
                    max_steps=4096,
                )
                pts = [
                    (cx + r * math.cos(2 * math.pi * k / steps), cy + r * math.sin(2 * math.pi * k / steps))
                    for k in range(steps)
                ]
                extracted = [(pts, True)]
        elif tag == "ellipse":
            cx = float(elem.get("cx") or 0.0)
            cy = float(elem.get("cy") or 0.0)
            rx = float(elem.get("rx") or 0.0)
            ry = float(elem.get("ry") or 0.0)
            if rx > 0 and ry > 0:
                sx_eff = math.hypot(mat[0, 0], mat[1, 0]) * coord_scale
                sy_eff = math.hypot(mat[0, 1], mat[1, 1]) * coord_scale
                steps = adaptive_arc_steps(
                    max(rx * sx_eff, ry * sy_eff, 1e-9),
                    2.0 * math.pi,
                    min_steps=64,
                    max_steps=4096,
                )
                pts = [
                    (cx + rx * math.cos(2 * math.pi * k / steps), cy + ry * math.sin(2 * math.pi * k / steps))
                    for k in range(steps)
                ]
                extracted = [(pts, True)]

        for pts, closed in extracted:
            tpts = apply_matrix(mat, pts, scale=coord_scale)
            closed_eff = closed or (
                len(tpts) >= 3 and math.hypot(tpts[0][0] - tpts[-1][0], tpts[0][1] - tpts[-1][1]) <= 1e-2
            )
            m = polygon_metrics(tpts, closed_eff)
            m["tag"] = tag
            m["layer"] = layer_id
            m["dashed"] = is_dashed
            m["stroke"] = stroke
            m["fill"] = fill
            shapes.append(m)

        for child in elem:
            walk(child, mat, layer_id, stroke, fill, eff_dash)

    walk(root_elem, np.eye(3, dtype=np.float64), "", None, None, "")
    return shapes, layers


def extract_svg_geometry(svg_path: str, coord_scale: Optional[float] = None) -> Dict[str, Any]:
    parser = ET.XMLParser(resolve_entities=False)
    tree = ET.parse(svg_path, parser)
    root = tree.getroot()

    width_attr = root.get("width")
    height_attr = root.get("height")
    vb_attr = root.get("viewBox")

    w_mm, w_unit = parse_length_mm(width_attr)
    h_mm, h_unit = parse_length_mm(height_attr)

    vb = None
    if vb_attr:
        vb_nums = [float(x) for x in NUM_RE.findall(vb_attr)]
        if len(vb_nums) >= 4:
            vb = tuple(vb_nums[:4])

    scale = coord_scale if coord_scale is not None else 1.0
    shapes, layers = extract_svg_elements_geometry(root, coord_scale=scale)

    return {
        "widthMm": w_mm,
        "heightMm": h_mm,
        "widthUnit": w_unit,
        "heightUnit": h_unit,
        "viewBox": vb,
        "layers": layers,
        "shapes": shapes,
    }


def is_square_of_size(shape: Dict[str, Any], target_mm: float, tol_mm: float) -> bool:
    if not shape.get("closed"):
        return False
    w = shape["widthMm"]
    h = shape["heightMm"]
    area = shape["areaMm2"]
    perim = shape["perimeterMm"]
    if abs(w - target_mm) > tol_mm + FLOAT_CMP_EPS or abs(h - target_mm) > tol_mm + FLOAT_CMP_EPS:
        return False
    if abs(area - w * h) > max(2.0, 0.02 * w * h) + FLOAT_CMP_EPS:
        return False
    if abs(perim - 4.0 * target_mm) > 4.0 * tol_mm + 0.1 + FLOAT_CMP_EPS:
        return False
    return True


def point_in_polygon(px: float, py: float, pts: List[Tuple[float, float]]) -> bool:
    n = len(pts)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > py) != (yj > py):
            denom = (yj - yi) if abs(yj - yi) > 1e-12 else 1e-12
            if px < (xj - xi) * (py - yi) / denom + xi:
                inside = not inside
        j = i
    return inside


def segments_intersect_2d(
    a1: Tuple[float, float],
    a2: Tuple[float, float],
    b1: Tuple[float, float],
    b2: Tuple[float, float],
    eps: float = 1e-7,
) -> bool:
    ax1, ay1 = a1
    ax2, ay2 = a2
    bx1, by1 = b1
    bx2, by2 = b2

    if (
        max(ax1, ax2) + eps < min(bx1, bx2)
        or max(bx1, bx2) + eps < min(ax1, ax2)
        or max(ay1, ay2) + eps < min(by1, by2)
        or max(by1, by2) + eps < min(ay1, ay2)
    ):
        return False

    def cross(ox: float, oy: float, px: float, py: float, qx: float, qy: float) -> float:
        return (px - ox) * (qy - oy) - (py - oy) * (qx - ox)

    def on_seg(px: float, py: float, qx: float, qy: float, rx: float, ry: float) -> bool:
        return (
            qx <= max(px, rx) + eps
            and qx >= min(px, rx) - eps
            and qy <= max(py, ry) + eps
            and qy >= min(py, ry) - eps
        )

    len_a = math.hypot(ax2 - ax1, ay2 - ay1)
    len_b = math.hypot(bx2 - bx1, by2 - by1)
    tol_a = eps * max(1.0, len_a)
    tol_b = eps * max(1.0, len_b)

    d1 = cross(ax1, ay1, ax2, ay2, bx1, by1)
    d2 = cross(ax1, ay1, ax2, ay2, bx2, by2)
    d3 = cross(bx1, by1, bx2, by2, ax1, ay1)
    d4 = cross(bx1, by1, bx2, by2, ax2, ay2)

    if ((d1 > tol_a and d2 < -tol_a) or (d1 < -tol_a and d2 > tol_a)) and (
        (d3 > tol_b and d4 < -tol_b) or (d3 < -tol_b and d4 > tol_b)
    ):
        return True

    if abs(d1) <= tol_a and on_seg(ax1, ay1, bx1, by1, ax2, ay2):
        return True
    if abs(d2) <= tol_a and on_seg(ax1, ay1, bx2, by2, ax2, ay2):
        return True
    if abs(d3) <= tol_b and on_seg(bx1, by1, ax1, ay1, bx2, by2):
        return True
    if abs(d4) <= tol_b and on_seg(bx1, by1, ax2, ay2, bx2, by2):
        return True

    return False


def polygon_self_intersects(pts: List[Tuple[float, float]], eps: float = 1e-6) -> bool:
    clean: List[Tuple[float, float]] = []
    for p in pts:
        if not clean or math.hypot(p[0] - clean[-1][0], p[1] - clean[-1][1]) > eps:
            clean.append(p)
    if len(clean) >= 2 and math.hypot(clean[0][0] - clean[-1][0], clean[0][1] - clean[-1][1]) <= eps:
        clean.pop()
    n = len(clean)
    if n < 3:
        return False

    edges = []
    for i in range(n):
        a = clean[i]
        b = clean[(i + 1) % n]
        edges.append((
            min(a[0], b[0]),
            max(a[0], b[0]),
            min(a[1], b[1]),
            max(a[1], b[1]),
            i,
            a,
            b,
        ))
    edges.sort(key=lambda e: e[0])

    for p in range(n):
        min_x1, max_x1, min_y1, max_y1, i, a1, a2 = edges[p]
        for q in range(p + 1, n):
            min_x2, max_x2, min_y2, max_y2, j, b1, b2 = edges[q]
            if min_x2 > max_x1 + eps:
                break
            if min_y2 > max_y1 + eps or min_y1 > max_y2 + eps:
                continue
            idx_diff = abs(i - j)
            if idx_diff == 1 or idx_diff == n - 1:
                # Ensure e1 precedes e2 in polygon order to test collinear fold-back
                if (i + 1) % n == j:
                    u1, u2, v1, v2 = a1, a2, b1, b2
                else:
                    u1, u2, v1, v2 = b1, b2, a1, a2
                vx1, vy1 = u2[0] - u1[0], u2[1] - u1[1]
                vx2, vy2 = v2[0] - v1[0], v2[1] - v1[1]
                len1 = math.hypot(vx1, vy1)
                len2 = math.hypot(vx2, vy2)
                if len1 > eps and len2 > eps:
                    cross_norm = abs(vx1 * vy2 - vy1 * vx2) / (len1 * len2)
                    dot = vx1 * vx2 + vy1 * vy2
                    if cross_norm <= 1e-6 and dot < 0.0:
                        return True
                continue
            if segments_intersect_2d(a1, a2, b1, b2, eps=1e-7):
                return True
    return False


def is_axis_aligned_rect(shape: Dict[str, Any]) -> bool:
    if not shape.get("closed"):
        return False
    pts = shape.get("points") or []
    if len(pts) != 4:
        return False
    w = shape["widthMm"]
    h = shape["heightMm"]
    if w <= 0.0 or h <= 0.0:
        return False
    if abs(shape["areaMm2"] - w * h) > max(1.0, 0.005 * w * h):
        return False
    if abs(shape["perimeterMm"] - 2.0 * (w + h)) > 0.5:
        return False
    min_x, max_x = shape["minX"], shape["maxX"]
    min_y, max_y = shape["minY"], shape["maxY"]
    for px, py in pts:
        on_x = abs(px - min_x) <= 0.15 or abs(px - max_x) <= 0.15
        on_y = abs(py - min_y) <= 0.15 or abs(py - max_y) <= 0.15
        if not (on_x and on_y):
            return False
    return True


def is_unstroked_page_bg(shape: Dict[str, Any], page_w_mm: float, page_h_mm: float) -> bool:
    if not is_axis_aligned_rect(shape):
        return False
    w = shape["widthMm"]
    h = shape["heightMm"]
    if w < page_w_mm - 0.5 or h < page_h_mm - 0.5:
        return False
    if shape["minX"] < -1.0 or shape["maxX"] > page_w_mm + 1.0 or shape["minY"] < -1.0 or shape["maxY"] > page_h_mm + 1.0:
        return False
    stroke_str = (shape.get("stroke") or "").strip().lower()
    fill_str = (shape.get("fill") or "").strip().lower()
    if stroke_str in ("none", "transparent"):
        return True
    if stroke_str == "" and fill_str not in ("", "none", "transparent"):
        return True
    return False


def _is_calib_like_shape(
    shape: Dict[str, Any],
    page_w_mm: float,
    page_h_mm: float,
    calib_size: float,
    calib_tol: float,
) -> bool:
    if is_square_of_size(shape, calib_size, calib_tol) or is_square_of_size(shape, 50.8, calib_tol):
        return True
    if (page_w_mm < 84.0 or page_h_mm < 84.0) and (
        is_square_of_size(shape, 20.0, calib_tol) or is_square_of_size(shape, 10.0, calib_tol)
    ):
        return True
    return False


def is_tile_border_shape(
    shape: Dict[str, Any],
    page_w_mm: float,
    page_h_mm: float,
    margin_mm: Optional[float] = None,
    calib_size: float = 50.0,
    calib_tol: float = 0.1,
    has_reg_marks: bool = False,
    page_count: int = 1,
    ctm_dx: float = 0.0,
    ctm_dy: float = 0.0,
) -> bool:
    if shape.get("dashed"):
        return False
    if not is_axis_aligned_rect(shape):
        return False
    if is_unstroked_page_bg(shape, page_w_mm, page_h_mm):
        return False
    if _is_calib_like_shape(shape, page_w_mm, page_h_mm, calib_size, calib_tol):
        return False
    w = shape["widthMm"]
    h = shape["heightMm"]
    if w > page_w_mm + 0.5 or h > page_h_mm + 0.5:
        return False
    min_x = shape["minX"]
    max_x = shape["maxX"]
    min_y = shape["minY"]
    max_y = shape["maxY"]
    if min_x < -1.0 or max_x > page_w_mm + 1.0 or min_y < -1.0 or max_y > page_h_mm + 1.0:
        return False
    cx = 0.5 * (min_x + max_x) - ctm_dx
    cy = 0.5 * (min_y + max_y) - ctm_dy
    if abs(cx - 0.5 * page_w_mm) > 1.5 or abs(cy - 0.5 * page_h_mm) > 1.5:
        return False
    left_m = min_x - ctm_dx
    right_m = page_w_mm - (max_x - ctm_dx)
    top_m = min_y - ctm_dy
    bottom_m = page_h_mm - (max_y - ctm_dy)
    if abs(left_m - right_m) > 0.4 or abs(top_m - bottom_m) > 0.4:
        return False
    is_uniform = (max(left_m, right_m, top_m, bottom_m) - min(left_m, right_m, top_m, bottom_m)) <= 0.4
    if margin_mm is not None:
        m_val = float(margin_mm)
        exp_pw = page_w_mm - 2.0 * m_val
        exp_ph = page_h_mm - 2.0 * m_val
        match_tol = 0.4 if abs(m_val) <= 0.4 else 2.0
        if is_uniform and abs(w - exp_pw) <= match_tol and abs(h - exp_ph) <= match_tol:
            return True
        if (page_count > 1 or has_reg_marks) and is_uniform and left_m >= -0.5 and top_m >= -0.5:
            if (left_m <= 35.0 and top_m <= 35.0) or (w > page_w_mm * 0.45 and h > page_h_mm * 0.45):
                return True
        return False
    if page_count <= 1 and not has_reg_marks:
        return False
    if 2.0 <= left_m <= 35.0 and 2.0 <= top_m <= 35.0:
        return True
    if w > page_w_mm * 0.65 and h > page_h_mm * 0.65:
        return True
    return False


def is_corner_reg_mark(
    shape: Dict[str, Any],
    page_w_mm: float,
    page_h_mm: float,
    calib_size: float,
    calib_tol: float,
    pshapes: Optional[List[Dict[str, Any]]] = None,
) -> bool:
    if is_square_of_size(shape, calib_size, calib_tol) or is_square_of_size(shape, 50.8, calib_tol):
        return False
    if (page_w_mm < 84.0 or page_h_mm < 84.0) and (
        is_square_of_size(shape, 20.0, calib_tol) or is_square_of_size(shape, 10.0, calib_tol)
    ):
        return False

    w = shape["widthMm"]
    h = shape["heightMm"]
    cx = 0.5 * (shape["minX"] + shape["maxX"])
    cy = 0.5 * (shape["minY"] + shape["maxY"])
    near_left_right = cx <= 50.0 or cx >= (page_w_mm - 50.0)
    near_top_bot = cy <= 50.0 or cy >= (page_h_mm - 50.0)
    if not (near_left_right and near_top_bot):
        return False

    if shape.get("closed"):
        if (
            w < 9.95
            and h < 9.95
            and (w >= 1.5 or h >= 1.5)
            and not polygon_self_intersects(shape.get("points") or [])
        ):
            return True
        return False

    if not shape.get("closed") and not shape.get("dashed") and shape.get("vertexCount") == 2:
        if 1.5 <= max(w, h) <= 12.0 and min(w, h) <= 0.2:
            is_horiz = h <= 0.2
            if pshapes is not None:
                for s2 in pshapes:
                    if s2 is shape or s2.get("closed") or s2.get("dashed") or s2.get("vertexCount") != 2:
                        continue
                    w2, h2 = s2["widthMm"], s2["heightMm"]
                    if not (1.5 <= max(w2, h2) <= 12.0 and min(w2, h2) <= 0.2):
                        continue
                    if (h2 <= 0.2) == is_horiz:
                        continue
                    cx2 = 0.5 * (s2["minX"] + s2["maxX"])
                    cy2 = 0.5 * (s2["minY"] + s2["maxY"])
                    if math.hypot(cx - cx2, cy - cy2) <= 0.5:
                        return True
            if is_horiz:
                at_tb = abs(cy) <= 0.5 or abs(cy - page_h_mm) <= 0.5
                straddles_lr = (
                    (shape["minX"] < -0.5 and shape["maxX"] > 0.5 and abs(cx) <= 0.5)
                    or (
                        shape["minX"] < page_w_mm - 0.5
                        and shape["maxX"] > page_w_mm + 0.5
                        and abs(cx - page_w_mm) <= 0.5
                    )
                )
                if at_tb and straddles_lr:
                    return True
            else:
                at_lr = abs(cx) <= 0.5 or abs(cx - page_w_mm) <= 0.5
                straddles_tb = (
                    (shape["minY"] < -0.5 and shape["maxY"] > 0.5 and abs(cy) <= 0.5)
                    or (
                        shape["minY"] < page_h_mm - 0.5
                        and shape["maxY"] > page_h_mm + 0.5
                        and abs(cy - page_h_mm) <= 0.5
                    )
                )
                if at_lr and straddles_tb:
                    return True
    return False


def extract_tile_marks_and_frame(
    pshapes: List[Dict[str, Any]],
    page_w_mm: float,
    page_h_mm: float,
    calib_size: float,
    calib_tol: float,
    margin_mm: Optional[float] = None,
    page_count: int = 1,
    expected_pieces: Optional[List[Dict[str, Any]]] = None,
    ctm_dx: float = 0.0,
    ctm_dy: float = 0.0,
) -> Dict[str, Any]:
    reg_marks = [
        s for s in pshapes
        if is_corner_reg_mark(s, page_w_mm, page_h_mm, calib_size, calib_tol, pshapes=pshapes)
    ]
    reg_x_min = reg_x_max = reg_y_min = reg_y_max = None
    reg_span_x = reg_span_y = None
    if reg_marks:
        cxs = [0.5 * (s["minX"] + s["maxX"]) for s in reg_marks]
        cys = [0.5 * (s["minY"] + s["maxY"]) for s in reg_marks]
        reg_x_min, reg_x_max = min(cxs), max(cxs)
        reg_y_min, reg_y_max = min(cys), max(cys)
        reg_span_x = reg_x_max - reg_x_min
        reg_span_y = reg_y_max - reg_y_min

    has_corner_reg = len(reg_marks) >= 1
    frames = [
        s for s in pshapes
        if is_tile_border_shape(
            s, page_w_mm, page_h_mm, margin_mm=margin_mm, calib_size=calib_size,
            calib_tol=calib_tol, has_reg_marks=has_corner_reg, page_count=page_count,
            ctm_dx=ctm_dx, ctm_dy=ctm_dy,
        )
    ]

    def _norm_margins(cand: Dict[str, Any]) -> Tuple[float, float, float, float]:
        lm = cand["minX"] - ctm_dx
        rm = page_w_mm - (cand["maxX"] - ctm_dx)
        tm = cand["minY"] - ctm_dy
        bm = page_h_mm - (cand["maxY"] - ctm_dy)
        return lm, rm, tm, bm

    def _is_axis_symmetric_frame_margins(cand: Dict[str, Any]) -> bool:
        lm, rm, tm, bm = _norm_margins(cand)
        return abs(lm - rm) <= 0.4 and abs(tm - bm) <= 0.4

    def _is_uniform_frame_margins(cand: Dict[str, Any]) -> bool:
        lm, rm, tm, bm = _norm_margins(cand)
        return (max(lm, rm, tm, bm) - min(lm, rm, tm, bm)) <= 0.4

    def _matches_expected_piece_rect(f_cand: Dict[str, Any]) -> bool:
        if not expected_pieces:
            return False
        fw, fh = f_cand["widthMm"], f_cand["heightMm"]
        fa = float(f_cand.get("areaMm2", fw * fh))
        fp = float(f_cand.get("perimeterMm", 2.0 * (fw + fh)))
        for exp_p in expected_pieces:
            ew = exp_p.get("widthMm")
            eh = exp_p.get("heightMm")
            ea = exp_p.get("areaMm2")
            ep = exp_p.get("perimeterMm")
            if ew is None and eh is None and ea is None and ep is None:
                continue
            tol_e = float(exp_p.get("tolMm", 0.1))
            dims_ok = True
            if ew is not None and eh is not None:
                dims_ok = (
                    (abs(fw - float(ew)) <= tol_e + 0.2 and abs(fh - float(eh)) <= tol_e + 0.2)
                    or (abs(fw - float(eh)) <= tol_e + 0.2 and abs(fh - float(ew)) <= tol_e + 0.2)
                )
            elif ew is not None:
                dims_ok = abs(fw - float(ew)) <= tol_e + 0.2 or abs(fh - float(ew)) <= tol_e + 0.2
            elif eh is not None:
                dims_ok = abs(fw - float(eh)) <= tol_e + 0.2 or abs(fh - float(eh)) <= tol_e + 0.2
            area_ok = True if ea is None else abs(fa - float(ea)) <= max(5.0, float(ea) * 0.02)
            perim_ok = True if ep is None else abs(fp - float(ep)) <= max(2.0, 4.0 * tol_e)
            if dims_ok and area_ok and perim_ok:
                return True
        return False

    def _is_uniform_page_frame_like(cand: Dict[str, Any]) -> bool:
        if not is_axis_aligned_rect(cand):
            return False
        if is_unstroked_page_bg(cand, page_w_mm, page_h_mm):
            return False
        lm, rm, tm, bm = _norm_margins(cand)
        if lm < -0.5 or rm < -0.5 or tm < -0.5 or bm < -0.5:
            return False
        return (max(lm, rm, tm, bm) - min(lm, rm, tm, bm)) <= 0.4

    def _parse_rgb_01(stroke_val: Any) -> Optional[Tuple[float, float, float]]:
        if not isinstance(stroke_val, str):
            return None
        s_txt = stroke_val.strip().lower()
        if not s_txt or s_txt == "none":
            return None
        m_pct = re.match(
            r"rgb\(\s*([0-9.]+)\s*%\s*,\s*([0-9.]+)\s*%\s*,\s*([0-9.]+)\s*%\s*\)",
            s_txt,
        )
        if m_pct:
            return (
                float(m_pct.group(1)) / 100.0,
                float(m_pct.group(2)) / 100.0,
                float(m_pct.group(3)) / 100.0,
            )
        m_int = re.match(
            r"rgb\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)",
            s_txt,
        )
        if m_int:
            return (
                float(m_int.group(1)) / 255.0,
                float(m_int.group(2)) / 255.0,
                float(m_int.group(3)) / 255.0,
            )
        m_hex = re.match(r"#([0-9a-f]{6})$", s_txt)
        if m_hex:
            hx = m_hex.group(1)
            return (
                int(hx[0:2], 16) / 255.0,
                int(hx[2:4], 16) / 255.0,
                int(hx[4:6], 16) / 255.0,
            )
        return None

    def _is_tile_frame_stroke(s_obj: Dict[str, Any]) -> bool:
        rgb = _parse_rgb_01(s_obj.get("stroke"))
        if rgb is None:
            return False
        r, g, b = rgb
        return (
            0.55 <= r <= 0.85
            and 0.55 <= g <= 0.85
            and 0.55 <= b <= 0.85
            and (max(r, g, b) - min(r, g, b)) <= 0.08
        )

    def _is_cut_piece_stroke(s_obj: Dict[str, Any]) -> bool:
        rgb = _parse_rgb_01(s_obj.get("stroke"))
        if rgb is None:
            return False
        r, g, b = rgb
        return r <= 0.12 and g <= 0.14 and b <= 0.22 and b > r + 0.03

    def _is_wrapped_by_inpage_solid(s_obj: Dict[str, Any]) -> bool:
        rx0, ry0, rx1, ry1 = s_obj["minX"], s_obj["minY"], s_obj["maxX"], s_obj["maxY"]
        for other in pshapes:
            if other is s_obj or not other.get("closed") or other.get("dashed"):
                continue
            if is_unstroked_page_bg(other, page_w_mm, page_h_mm):
                continue
            if _is_calib_like_shape(other, page_w_mm, page_h_mm, calib_size, calib_tol):
                continue
            if is_corner_reg_mark(other, page_w_mm, page_h_mm, calib_size, calib_tol, pshapes=pshapes):
                continue
            ox0, ox1 = other["minX"], other["maxX"]
            oy0, oy1 = other["minY"], other["maxY"]
            if (
                ox0 <= rx0 - 0.5
                and ox1 >= rx1 + 0.5
                and oy0 <= ry0 - 0.5
                and oy1 >= ry1 + 0.5
                and ox0 >= ctm_dx - 0.5
                and ox1 <= ctm_dx + page_w_mm + 0.5
                and oy0 >= ctm_dy - 0.5
                and oy1 <= ctm_dy + page_h_mm + 0.5
                and not (_is_uniform_page_frame_like(other) and not _matches_expected_piece_rect(other))
            ):
                return True
        return False

    def _rect_intersects_interior(
        other: Dict[str, Any], rx0: float, ry0: float, rx1: float, ry1: float,
        f_cand: Optional[Dict[str, Any]] = None,
    ) -> bool:
        ox0, ox1 = other["minX"], other["maxX"]
        oy0, oy1 = other["minY"], other["maxY"]
        if ox0 >= rx0 - 0.5 and ox1 <= rx1 + 0.5 and oy0 >= ry0 - 0.5 and oy1 <= ry1 + 0.5:
            return True
        if ox0 <= rx0 - 0.5 and ox1 >= rx1 + 0.5 and oy0 <= ry0 - 0.5 and oy1 >= ry1 + 0.5:
            if _is_uniform_page_frame_like(other) and not _matches_expected_piece_rect(other):
                return False
            if f_cand is None:
                return False
            if not _is_uniform_frame_margins(f_cand) or _matches_expected_piece_rect(f_cand):
                return False
            lm_f, _, tm_f, _ = _norm_margins(f_cand)
            if not (
                -0.5 <= lm_f <= 35.0 and -0.5 <= tm_f <= 35.0
                and f_cand["widthMm"] > page_w_mm * 0.5 and f_cand["heightMm"] > page_h_mm * 0.5
            ):
                return False
            other_exceeds_page = (
                ox0 < ctm_dx - 0.5
                or ox1 > ctm_dx + page_w_mm + 0.5
                or oy0 < ctm_dy - 0.5
                or oy1 > ctm_dy + page_h_mm + 0.5
            )
            if other_exceeds_page or _is_tile_frame_stroke(f_cand):
                return True
            if reg_marks and _has_contradictory_sym_page_corners(f_cand):
                lm_r = reg_x_min - ctm_dx
                tm_r = reg_y_min - ctm_dy
                if lm_r >= 2.0 and tm_r >= 2.0:
                    return True
            return False
        iw = min(ox1, rx1) - max(ox0, rx0)
        ih = min(oy1, ry1) - max(oy0, ry0)
        return iw > 2.0 and ih > 2.0

    def _encloses_non_aux_solid(f_cand: Dict[str, Any]) -> bool:
        rx0, ry0, rx1, ry1 = f_cand["minX"], f_cand["minY"], f_cand["maxX"], f_cand["maxY"]
        for other in pshapes:
            if other is f_cand:
                continue
            if not other.get("closed") or other.get("dashed"):
                continue
            if is_unstroked_page_bg(other, page_w_mm, page_h_mm):
                continue
            if _is_calib_like_shape(other, page_w_mm, page_h_mm, calib_size, calib_tol):
                continue
            if is_corner_reg_mark(other, page_w_mm, page_h_mm, calib_size, calib_tol, pshapes=pshapes):
                continue
            if max(other["widthMm"], other["heightMm"]) < 9.95:
                continue
            if _rect_intersects_interior(other, rx0, ry0, rx1, ry1, f_cand=f_cand):
                return True
        return False

    def _encloses_open_non_dashed(f_cand: Dict[str, Any], min_len: float = 10.0) -> bool:
        rx0, ry0, rx1, ry1 = f_cand["minX"], f_cand["minY"], f_cand["maxX"], f_cand["maxY"]
        for other in pshapes:
            if other is f_cand or other.get("closed") or other.get("dashed"):
                continue
            if is_unstroked_page_bg(other, page_w_mm, page_h_mm):
                continue
            if math.hypot(other["widthMm"], other["heightMm"]) < min_len:
                continue
            if (
                other["minX"] >= rx0 - 0.5 and other["maxX"] <= rx1 + 0.5
                and other["minY"] >= ry0 - 0.5 and other["maxY"] <= ry1 + 0.5
            ):
                return True
        return False

    def _encloses_any_non_calib_pattern_shape(f_cand: Dict[str, Any]) -> bool:
        if _encloses_non_aux_solid(f_cand) or _encloses_open_non_dashed(f_cand, min_len=10.0):
            return True
        rx0, ry0, rx1, ry1 = f_cand["minX"], f_cand["minY"], f_cand["maxX"], f_cand["maxY"]
        for other in pshapes:
            if other is f_cand or not other.get("closed") or other.get("dashed"):
                continue
            if is_unstroked_page_bg(other, page_w_mm, page_h_mm):
                continue
            if _is_calib_like_shape(other, page_w_mm, page_h_mm, calib_size, calib_tol):
                continue
            if is_corner_reg_mark(other, page_w_mm, page_h_mm, calib_size, calib_tol, pshapes=pshapes):
                continue
            if _rect_intersects_interior(other, rx0, ry0, rx1, ry1, f_cand=f_cand):
                return True
        return False

    if margin_mm is not None:
        m_val = float(margin_mm)
        exp_pw = page_w_mm - 2.0 * m_val
        exp_ph = page_h_mm - 2.0 * m_val
        match_tol = 0.4 if abs(m_val) <= 0.4 else 2.0
        matching_frames = [
            f for f in frames
            if abs(f["widthMm"] - exp_pw) <= match_tol
            and abs(f["heightMm"] - exp_ph) <= match_tol
            and _is_uniform_frame_margins(f)
        ]
        if matching_frames:
            frames = matching_frames
        else:
            frames = [f for f in frames if not _matches_expected_piece_rect(f)]
            for s_cand in pshapes:
                if s_cand in frames or s_cand.get("dashed") or not is_axis_aligned_rect(s_cand):
                    continue
                if is_unstroked_page_bg(s_cand, page_w_mm, page_h_mm) or _is_calib_like_shape(
                    s_cand, page_w_mm, page_h_mm, calib_size, calib_tol
                ):
                    continue
                sw_c, sh_c = s_cand["widthMm"], s_cand["heightMm"]
                if sw_c > page_w_mm + 0.5 or sh_c > page_h_mm + 0.5:
                    continue
                smin_x, smax_x = s_cand["minX"], s_cand["maxX"]
                smin_y, smax_y = s_cand["minY"], s_cand["maxY"]
                if smin_x < -1.0 or smax_x > page_w_mm + 1.0 or smin_y < -1.0 or smax_y > page_h_mm + 1.0:
                    continue
                scx = 0.5 * (smin_x + smax_x) - ctm_dx
                scy = 0.5 * (smin_y + smax_y) - ctm_dy
                if abs(scx - 0.5 * page_w_mm) > 1.5 or abs(scy - 0.5 * page_h_mm) > 1.5:
                    continue
                lm_c, rm_c, tm_c, bm_c = _norm_margins(s_cand)
                if abs(lm_c - rm_c) > 0.4 or abs(tm_c - bm_c) > 0.4:
                    continue
                if _matches_expected_piece_rect(s_cand):
                    continue

                encloses_solid = _encloses_non_aux_solid(s_cand)
                encloses_calib_strict = any(
                    other is not s_cand
                    and _is_calib_like_shape(other, page_w_mm, page_h_mm, calib_size, calib_tol)
                    and other["minX"] >= smin_x - 0.5
                    and other["maxX"] <= smax_x + 0.5
                    and other["minY"] >= smin_y - 0.5
                    and other["maxY"] <= smax_y + 0.5
                    for other in pshapes
                )
                encloses_open = _encloses_open_non_dashed(s_cand, min_len=10.0)
                is_frame_stroke_c = _is_tile_frame_stroke(s_cand)
                is_wrapped_solid_c = _is_wrapped_by_inpage_solid(s_cand)

                is_calib_only_band = (
                    (2.0 <= lm_c <= 35.0 and 2.0 <= tm_c <= 35.0)
                    or (m_val > 0.5 and abs(lm_c) <= 0.4 and abs(tm_c) <= 0.4)
                    or ((page_count > 1 or bool(reg_marks)) and -0.5 <= lm_c <= 35.0 and -0.5 <= tm_c <= 35.0)
                    or is_frame_stroke_c
                )
                is_open_band = (
                    (-0.5 <= lm_c <= 35.0 and -0.5 <= tm_c <= 35.0)
                    or (sw_c > page_w_mm * 0.45 and sh_c > page_h_mm * 0.45)
                )
                is_uniform_wrong_frame = (
                    (max(lm_c, rm_c, tm_c, bm_c) - min(lm_c, rm_c, tm_c, bm_c)) <= 0.4
                    and lm_c >= -0.5 and tm_c >= -0.5
                    and (not is_wrapped_solid_c or is_frame_stroke_c)
                    and (
                        encloses_solid
                        or (encloses_open and is_open_band)
                        or (encloses_calib_strict and is_calib_only_band)
                    )
                )
                is_asym_wrong_frame = (
                    (
                        encloses_solid
                        and lm_c >= -0.5 and tm_c >= -0.5
                        and (
                            abs(sw_c - exp_pw) <= match_tol
                            or abs(sh_c - exp_ph) <= match_tol
                            or encloses_calib_strict
                            or is_frame_stroke_c
                        )
                    )
                    or (
                        (abs(sw_c - exp_pw) <= match_tol or abs(sh_c - exp_ph) <= match_tol)
                        and (0.0 <= lm_c <= 35.0 and 0.0 <= tm_c <= 35.0)
                        and (sw_c > page_w_mm * 0.65 and sh_c > page_h_mm * 0.65)
                        and (
                            encloses_solid
                            or (
                                (encloses_calib_strict or encloses_open)
                                and (abs(lm_c - tm_c) <= 5.0 or is_frame_stroke_c)
                            )
                        )
                    )
                )
                if is_uniform_wrong_frame or is_asym_wrong_frame:
                    frames.append(s_cand)

    def _at_frame_corner(cx: float, cy: float, f_cand: Dict[str, Any], tol: float = 1.5) -> bool:
        return (
            (abs(cx - f_cand["minX"]) <= tol or abs(cx - f_cand["maxX"]) <= tol)
            and (abs(cy - f_cand["minY"]) <= tol or abs(cy - f_cand["maxY"]) <= tol)
        )

    def _has_4_frame_corners(f_cand: Dict[str, Any], tol: float = 1.5) -> bool:
        corners = [
            (f_cand["minX"], f_cand["minY"]),
            (f_cand["maxX"], f_cand["minY"]),
            (f_cand["minX"], f_cand["maxY"]),
            (f_cand["maxX"], f_cand["maxY"]),
        ]
        return all(
            any(
                abs(0.5 * (r["minX"] + r["maxX"]) - px) <= tol
                and abs(0.5 * (r["minY"] + r["maxY"]) - py) <= tol
                for r in reg_marks
            )
            for px, py in corners
        )

    def _has_contradictory_sym_page_corners(f_cand: Dict[str, Any]) -> bool:
        if not reg_marks or _has_4_frame_corners(f_cand):
            return False
        distinct_pts: List[Tuple[float, float]] = []
        for r in reg_marks:
            cx_r = 0.5 * (r["minX"] + r["maxX"])
            cy_r = 0.5 * (r["minY"] + r["maxY"])
            if not any(math.hypot(cx_r - ux, cy_r - uy) <= 10.0 for ux, uy in distinct_pts):
                distinct_pts.append((cx_r, cy_r))
        if len(distinct_pts) < 3:
            return False
        if (reg_span_x or 0.0) <= max(10.0, page_w_mm * 0.5) or (reg_span_y or 0.0) <= max(10.0, page_h_mm * 0.5):
            return False
        if not all(
            (abs(0.5 * (r["minX"] + r["maxX"]) - reg_x_min) <= 1.5 or abs(0.5 * (r["minX"] + r["maxX"]) - reg_x_max) <= 1.5)
            and (abs(0.5 * (r["minY"] + r["maxY"]) - reg_y_min) <= 1.5 or abs(0.5 * (r["minY"] + r["maxY"]) - reg_y_max) <= 1.5)
            for r in reg_marks
        ):
            return False
        lm_r = reg_x_min - ctm_dx
        rm_r = page_w_mm - (reg_x_max - ctm_dx)
        tm_r = reg_y_min - ctm_dy
        bm_r = page_h_mm - (reg_y_max - ctm_dy)
        if not (
            abs(lm_r - rm_r) <= 1.5 and abs(tm_r - bm_r) <= 1.5 and abs(lm_r - tm_r) <= 1.5
            and -0.5 <= lm_r <= 35.0 and -0.5 <= tm_r <= 35.0
        ):
            return False
        lm_f, rm_f, tm_f, bm_f = _norm_margins(f_cand)
        return max(abs(lm_f - lm_r), abs(rm_f - rm_r), abs(tm_f - tm_r), abs(bm_f - bm_r)) > 1.5

    retained_contradictory: List[Dict[str, Any]] = []
    if margin_mm is None and frames and reg_marks:
        kept_frames: List[Dict[str, Any]] = []
        for f in frames:
            if _has_4_frame_corners(f) or any(
                _at_frame_corner(0.5 * (r["minX"] + r["maxX"]), 0.5 * (r["minY"] + r["maxY"]), f, tol=1.5)
                for r in reg_marks
            ):
                kept_frames.append(f)
            elif (
                not _matches_expected_piece_rect(f)
                and _is_axis_symmetric_frame_margins(f)
                and _encloses_non_aux_solid(f)
                and not _has_contradictory_sym_page_corners(f)
            ):
                kept_frames.append(f)
            elif (
                not _matches_expected_piece_rect(f)
                and _has_contradictory_sym_page_corners(f)
            ):
                lm_f, _, tm_f, _ = _norm_margins(f)
                keep_contra = False
                if _is_uniform_frame_margins(f):
                    if (
                        _is_tile_frame_stroke(f)
                        or page_count > 1
                        or _encloses_any_non_calib_pattern_shape(f)
                        or (not _is_wrapped_by_inpage_solid(f) and not _is_cut_piece_stroke(f))
                    ):
                        keep_contra = True
                elif _is_axis_symmetric_frame_margins(f):
                    if (
                        _is_tile_frame_stroke(f)
                        or (
                            2.0 <= lm_f <= 25.0
                            and 2.0 <= tm_f <= 25.0
                            and abs(lm_f - tm_f) <= 5.5
                            and f["widthMm"] > page_w_mm * 0.85
                            and f["heightMm"] > page_h_mm * 0.85
                            and (_encloses_open_non_dashed(f, min_len=10.0) or _encloses_non_aux_solid(f))
                        )
                    ):
                        keep_contra = True
                if keep_contra:
                    kept_frames.append(f)
                    retained_contradictory.append(f)
        frames = kept_frames

    def _has_own_corner_regs(f_cand: Dict[str, Any]) -> bool:
        return bool(reg_marks) and all(
            _at_frame_corner(0.5 * (r["minX"] + r["maxX"]), 0.5 * (r["minY"] + r["maxY"]), f_cand, tol=1.5)
            for r in reg_marks
        )

    sym_margin_frames: List[Dict[str, Any]] = []
    if frames:
        sym_margin_frames = [
            f for f in frames
            if (
                (
                    _is_uniform_frame_margins(f)
                    and 2.0 <= (f["minX"] - ctm_dx) <= 35.0
                    and 2.0 <= (f["minY"] - ctm_dy) <= 35.0
                    and (not _is_wrapped_by_inpage_solid(f) or _is_tile_frame_stroke(f))
                )
                or (
                    _encloses_non_aux_solid(f)
                    and _is_axis_symmetric_frame_margins(f)
                    and not _matches_expected_piece_rect(f)
                    and not _has_contradictory_sym_page_corners(f)
                )
                or (f in retained_contradictory)
            )
        ]
    if reg_span_x is not None:
        frames = [
            f for f in frames
            if f["widthMm"] >= reg_span_x - 2.0
            or _has_own_corner_regs(f)
            or (_encloses_non_aux_solid(f) and _is_axis_symmetric_frame_margins(f) and not _matches_expected_piece_rect(f))
            or (f in retained_contradictory)
        ]
    if reg_span_y is not None:
        frames = [
            f for f in frames
            if f["heightMm"] >= reg_span_y - 2.0
            or _has_own_corner_regs(f)
            or (_encloses_non_aux_solid(f) and _is_axis_symmetric_frame_margins(f) and not _matches_expected_piece_rect(f))
            or (f in retained_contradictory)
        ]
    if margin_mm is None and frames:
        frames = [
            f for f in frames
            if (
                f in sym_margin_frames
                or _has_4_frame_corners(f)
                or _has_own_corner_regs(f)
                or _is_tile_frame_stroke(f)
                or (
                    _is_uniform_frame_margins(f)
                    and -0.5 <= (f["minX"] - ctm_dx) <= 0.4
                    and -0.5 <= (f["minY"] - ctm_dy) <= 0.4
                )
            )
        ]
    elif not frames and sym_margin_frames:
        frames = sym_margin_frames

    frame = max(frames, key=lambda s: s["widthMm"] * s["heightMm"]) if frames else None
    return {
        "frame": frame,
        "regMarks": reg_marks,
        "regXMin": reg_x_min,
        "regXMax": reg_x_max,
        "regYMin": reg_y_min,
        "regYMax": reg_y_max,
        "regSpanX": reg_span_x,
        "regSpanY": reg_span_y,
    }


def shifted_polygon_max_error(
    pts1: List[Tuple[float, float]],
    pts2: List[Tuple[float, float]],
    dx: float,
    dy: float,
) -> float:
    shifted2 = [(p[0] + dx, p[1] + dy) for p in pts2]
    if len(pts1) == len(shifted2) and len(pts1) >= 3:
        direct = max(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(pts1, shifted2))
        if direct <= 0.1 + FLOAT_CMP_EPS:
            return direct
        if len(pts1) <= 64:
            best = direct
            rev2 = list(reversed(shifted2))
            n = len(pts1)
            for cand in (shifted2, rev2):
                for off in range(n):
                    err = max(
                        math.hypot(pts1[i][0] - cand[(i + off) % n][0], pts1[i][1] - cand[(i + off) % n][1])
                        for i in range(n)
                    )
                    if err < best:
                        best = err
            if best <= 0.1 + FLOAT_CMP_EPS:
                return best

    def poly_edges(pts: List[Tuple[float, float]]) -> List[Tuple[Tuple[float, float], Tuple[float, float]]]:
        return [(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]

    edges1 = poly_edges(pts1)
    edges2 = poly_edges(shifted2)
    max_d = 0.0
    for px, py in pts1:
        d = min(point_to_segment_dist(px, py, a[0], a[1], b[0], b[1]) for a, b in edges2)
        if d > max_d:
            max_d = d
    for px, py in shifted2:
        d = min(point_to_segment_dist(px, py, a[0], a[1], b[0], b[1]) for a, b in edges1)
        if d > max_d:
            max_d = d
    return max_d


def point_to_segment_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    c1 = vx * wx + vy * wy
    if c1 <= 0.0:
        return math.hypot(px - ax, py - ay)
    c2 = vx * vx + vy * vy
    if c2 <= c1:
        return math.hypot(px - bx, py - by)
    t = c1 / c2
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def _xy_tuple(pt: Any) -> Tuple[float, float]:
    if isinstance(pt, dict):
        return (float(pt["x"]), float(pt["y"]))
    return (float(pt[0]), float(pt[1]))


def check_curve_fidelity(shapes: List[Dict[str, Any]], expectations: Dict[str, Any], errors: List[str]) -> Optional[float]:
    segs = list(expectations.get("bezierSegments") or [])
    end_key = "p1" if "p1" in expectations else ("p3" if "p3" in expectations else None)
    if end_key and all(k in expectations for k in ("p0", "cp1", "cp2")):
        segs.append({
            "p0": expectations["p0"],
            "cp1": expectations["cp1"],
            "cp2": expectations["cp2"],
            "p1": expectations[end_key],
        })
    pts_expected = expectations.get("expectedCurvePoints") or []
    if not segs and not pts_expected:
        return None

    all_edges: List[Tuple[Tuple[float, float], Tuple[float, float]]] = []
    for sh in shapes:
        pts = sh["points"]
        if len(pts) < 2:
            continue
        for i in range(len(pts) - 1):
            all_edges.append((pts[i], pts[i + 1]))
        if sh["closed"] and len(pts) >= 3:
            all_edges.append((pts[-1], pts[0]))

    if not all_edges:
        errors.append("Curve fidelity check failed: no vector edges extracted")
        return None

    max_dev = 0.0
    tol = float(expectations.get("curveTolMm", expectations.get("tolMm", 0.1)))

    sample_pts: List[Tuple[float, float]] = [_xy_tuple(p) for p in pts_expected]
    for seg in segs:
        p0 = _xy_tuple(seg["p0"])
        cp1 = _xy_tuple(seg["cp1"])
        cp2 = _xy_tuple(seg["cp2"])
        p1 = _xy_tuple(seg["p1"] if "p1" in seg else seg["p3"])
        for k in range(51):
            t = k / 50.0
            mt = 1.0 - t
            x = mt**3 * p0[0] + 3 * mt**2 * t * cp1[0] + 3 * mt * t**2 * cp2[0] + t**3 * p1[0]
            y = mt**3 * p0[1] + 3 * mt**2 * t * cp1[1] + 3 * mt * t**2 * cp2[1] + t**3 * p1[1]
            sample_pts.append((x, y))

    for px, py in sample_pts:
        dmin = min(point_to_segment_dist(px, py, a[0], a[1], b[0], b[1]) for a, b in all_edges)
        if dmin > max_dev:
            max_dev = dmin

    if max_dev > tol + FLOAT_CMP_EPS:
        errors.append(f"Curve deviation {max_dev:.4f} mm exceeds tolerance {tol} mm")
    return max_dev


def is_cut_layer_name(layer: Optional[str]) -> bool:
    l = (layer or "").strip().lower()
    if not l or l.startswith(("seam-", "seam_", "seam ")):
        return False
    return (
        l == "cut"
        or l.startswith(("cut-", "cut_", "cut "))
        or "cut-lines" in l
        or bool(re.search(r"(?<![a-z])cut(?![a-z])", l))
    )


def is_seam_layer_name(layer: Optional[str]) -> bool:
    l = (layer or "").strip().lower()
    if not l or l.startswith(("cut-", "cut_", "cut ")):
        return False
    return (
        l == "seam"
        or l.startswith(("seam-", "seam_", "seam "))
        or "seam-lines" in l
        or bool(re.search(r"(?<![a-z])seam(?![a-z])", l))
    )


def is_calibration_layer_name(layer: Optional[str]) -> bool:
    l = (layer or "").strip().lower()
    return "calib" in l


def is_semantic_svg_layer(layer: Optional[str]) -> bool:
    l = (layer or "").strip().lower()
    if not l:
        return False
    if is_cut_layer_name(l) or is_seam_layer_name(l) or is_calibration_layer_name(l):
        return True
    return bool(
        re.search(
            r"(?<![a-z])(?:notch(?:es)?|grainlines?|internal(?:-lines)?|labels?)(?![a-z])",
            l,
        )
    )


def find_unmatched_seam_contours(
    seam_closed: List[Dict[str, Any]],
    cut_closed: List[Dict[str, Any]],
    tol: float = 0.25,
) -> List[Dict[str, Any]]:
    if not seam_closed:
        return []
    if not cut_closed:
        return list(seam_closed)

    cut_poly_cache: List[Optional[Tuple[Any, ...]]] = [None] * len(cut_closed)

    def _get_cut_poly_data(j: int) -> Optional[Tuple[Any, ...]]:
        cached = cut_poly_cache[j]
        if cached is not None:
            return cached
        c_pts = cut_closed[j].get("points") or []
        if len(c_pts) < 3:
            return None
        pts = np.asarray(c_pts, dtype=np.float64)
        qx0 = pts[:, 0]
        qy0 = pts[:, 1]
        qx1 = np.roll(qx0, -1)
        qy1 = np.roll(qy0, -1)
        edx = qx1 - qx0
        edy = qy1 - qy0
        elen2 = edx * edx + edy * edy
        data = (
            qx0,
            qy0,
            edx,
            edy,
            elen2,
            np.minimum(qx0, qx1),
            np.maximum(qx0, qx1),
            np.minimum(qy0, qy1),
            np.maximum(qy0, qy1),
        )
        cut_poly_cache[j] = data
        return data

    def _seam_geom_data(seam: Dict[str, Any]) -> Optional[Tuple[Any, ...]]:
        s_pts = seam.get("points") or []
        if len(s_pts) < 3:
            return None
        p = np.asarray(s_pts, dtype=np.float64)
        px0 = p[:, 0]
        py0 = p[:, 1]
        px1 = np.roll(px0, -1)
        py1 = np.roll(py0, -1)
        idx_dx = px1 - px0
        idx_dy = py1 - py0
        fracs = np.array([0.0, 0.25, 0.5, 0.75], dtype=np.float64)
        sx = (px0[:, None] + idx_dx[:, None] * fracs[None, :]).ravel()
        sy = (py0[:, None] + idx_dy[:, None] * fracs[None, :]).ravel()
        return (
            px0,
            py0,
            idx_dx,
            idx_dy,
            sx,
            sy,
            np.minimum(px0, px1),
            np.maximum(px0, px1),
            np.minimum(py0, py1),
            np.maximum(py0, py1),
        )

    def _pts_in_or_near_cut_vec(
        sx: np.ndarray,
        sy: np.ndarray,
        cut_data: Tuple[Any, ...],
    ) -> bool:
        qx0, qy0, edx, edy, elen2, emin_x, emax_x, emin_y, emax_y = cut_data
        tol2 = tol * tol
        n_pts = len(sx)
        safe_dy = np.where(np.abs(edy) > 1e-12, edy, 1e-12)
        safe_len2 = np.where(elen2 > 1e-24, elen2, 1.0)
        for start in range(0, n_pts, 256):
            end = min(n_pts, start + 256)
            px = sx[start:end, None]
            py = sy[start:end, None]
            qy1_v = qy0 + edy
            cond_y = (qy0[None, :] > py) != (qy1_v[None, :] > py)
            x_int = edx[None, :] * (py - qy0[None, :]) / safe_dy[None, :] + qx0[None, :]
            inside = (np.sum(cond_y & (px < x_int), axis=1) & 1) == 1
            if np.all(inside):
                continue
            out_px = px[~inside]
            out_py = py[~inside]
            near_edge = (
                (out_px >= emin_x[None, :] - tol)
                & (out_px <= emax_x[None, :] + tol)
                & (out_py >= emin_y[None, :] - tol)
                & (out_py <= emax_y[None, :] + tol)
            )
            if not np.all(np.any(near_edge, axis=1)):
                return False
            wx = out_px - qx0[None, :]
            wy = out_py - qy0[None, :]
            t = np.clip((wx * edx[None, :] + wy * edy[None, :]) / safe_len2[None, :], 0.0, 1.0)
            t = np.where(elen2[None, :] > 1e-24, t, 0.0)
            dx_e = out_px - (qx0[None, :] + t * edx[None, :])
            dy_e = out_py - (qy0[None, :] + t * edy[None, :])
            d2 = np.where(near_edge, dx_e * dx_e + dy_e * dy_e, tol2 + 1.0)
            if not np.all(np.min(d2, axis=1) <= tol2):
                return False
        return True

    def _seam_enclosed_by_cut(seam: Dict[str, Any], s_geom: Optional[Tuple[Any, ...]], j: int) -> bool:
        cut = cut_closed[j]
        if (
            cut["minX"] - tol > seam["minX"]
            or seam["maxX"] > cut["maxX"] + tol
            or cut["minY"] - tol > seam["minY"]
            or seam["maxY"] > cut["maxY"] + tol
        ):
            return False
        if cut["areaMm2"] < seam["areaMm2"] - max(1.0, 0.01 * seam["areaMm2"]):
            return False
        if s_geom is None:
            return False
        cut_data = _get_cut_poly_data(j)
        if cut_data is None:
            return False
        px0, py0, idx_dx, idx_dy, sx, sy, imin_x, imax_x, imin_y, imax_y = s_geom
        if not _pts_in_or_near_cut_vec(sx, sy, cut_data):
            return False
        qx0, qy0, _edx, _edy, _elen2, emin_x, emax_x, emin_y, emax_y = cut_data
        edx = cut_data[2]
        edy = cut_data[3]
        n_in = len(px0)
        sub_xs: List[float] = []
        sub_ys: List[float] = []
        for c0 in range(0, n_in, 256):
            c1 = min(n_in, c0 + 256)
            ov = (
                (imax_x[c0:c1, None] >= emin_x[None, :] - 1e-6)
                & (imin_x[c0:c1, None] <= emax_x[None, :] + 1e-6)
                & (imax_y[c0:c1, None] >= emin_y[None, :] - 1e-6)
                & (imin_y[c0:c1, None] <= emax_y[None, :] + 1e-6)
            )
            ii_loc, jj = np.nonzero(ov)
            if len(ii_loc) == 0:
                continue
            ii = ii_loc + c0
            ax = idx_dx[ii]
            ay = idx_dy[ii]
            bx = edx[jj]
            by = edy[jj]
            denom = ax * by - ay * bx
            valid_d = np.abs(denom) > 1e-12
            if not np.any(valid_d):
                continue
            ii = ii[valid_d]
            jj = jj[valid_d]
            ax = ax[valid_d]
            ay = ay[valid_d]
            bx = bx[valid_d]
            by = by[valid_d]
            denom = denom[valid_d]
            rx = qx0[jj] - px0[ii]
            ry = qy0[jj] - py0[ii]
            t_hit = (rx * by - ry * bx) / denom
            u_hit = (rx * ay - ry * ax) / denom
            mask = (t_hit > 1e-6) & (t_hit < 1.0 - 1e-6) & (u_hit >= -1e-6) & (u_hit <= 1.0 + 1e-6)
            if not np.any(mask):
                continue
            hits_by_edge: Dict[int, List[float]] = {}
            for ei, tv in zip(ii[mask].tolist(), t_hit[mask].tolist()):
                hits_by_edge.setdefault(ei, []).append(tv)
            for ei, hit_ts in hits_by_edge.items():
                ts = [0.0] + sorted(hit_ts) + [1.0]
                x0_e = float(px0[ei])
                y0_e = float(py0[ei])
                dx_e = float(idx_dx[ei])
                dy_e = float(idx_dy[ei])
                for k in range(len(ts) - 1):
                    t0, t1 = ts[k], ts[k + 1]
                    if t1 - t0 <= 1e-6:
                        continue
                    for frac in (0.25, 0.5, 0.75):
                        tf = t0 + frac * (t1 - t0)
                        sub_xs.append(x0_e + tf * dx_e)
                        sub_ys.append(y0_e + tf * dy_e)
        if sub_xs:
            if not _pts_in_or_near_cut_vec(
                np.asarray(sub_xs, dtype=np.float64),
                np.asarray(sub_ys, dtype=np.float64),
                cut_data,
            ):
                return False
        return True

    adj: List[List[int]] = []
    for seam in seam_closed:
        s_geom = _seam_geom_data(seam)
        cands = [
            (abs(cut_closed[j]["areaMm2"] - seam["areaMm2"]), j)
            for j in range(len(cut_closed))
            if _seam_enclosed_by_cut(seam, s_geom, j)
        ]
        cands.sort()
        adj.append([j for _, j in cands])

    cut_to_seam: Dict[int, int] = {}
    seam_matched: Dict[int, int] = {}

    def _try_aug(u: int, vis: set) -> bool:
        for v in adj[u]:
            if v in vis:
                continue
            vis.add(v)
            if v not in cut_to_seam or _try_aug(cut_to_seam[v], vis):
                cut_to_seam[v] = u
                seam_matched[u] = v
                return True
        return False

    for u in sorted(range(len(seam_closed)), key=lambda idx: (len(adj[idx]), idx)):
        _try_aug(u, set())

    return [seam_closed[i] for i in range(len(seam_closed)) if i not in seam_matched]


def check_expected_pieces(
    shapes: List[Dict[str, Any]],
    expectations: Dict[str, Any],
    calib_size: float,
    calib_tol: float,
    errors: List[str],
    check_cut_duplicates: bool = False,
) -> None:
    expected_pieces = list(expectations.get("expectedPieces") or [])
    if any(k in expectations for k in ("expectedWidthMm", "expectedHeightMm", "expectedAreaMm2", "expectedPerimeterMm")):
        expected_pieces.append({
            "widthMm": expectations.get("expectedWidthMm"),
            "heightMm": expectations.get("expectedHeightMm"),
            "areaMm2": expectations.get("expectedAreaMm2"),
            "perimeterMm": expectations.get("expectedPerimeterMm"),
            "tolMm": expectations.get("tolMm", 0.1),
        })

    if not expected_pieces:
        return

    closed_all = [s for s in shapes if s["closed"]]
    excluded_indices = set()

    def any_expected_matches_square(target_mm: float) -> bool:
        for exp in expected_pieces:
            tol_e = float(exp.get("tolMm", expectations.get("tolMm", 0.1)))
            ew_e = exp.get("widthMm")
            eh_e = exp.get("heightMm")
            if ew_e is not None and eh_e is not None:
                if abs(ew_e - target_mm) <= tol_e + calib_tol + FLOAT_CMP_EPS and abs(eh_e - target_mm) <= tol_e + calib_tol + FLOAT_CMP_EPS:
                    return True
            elif ew_e is not None and abs(ew_e - target_mm) <= tol_e + calib_tol + FLOAT_CMP_EPS:
                return True
            elif eh_e is not None and abs(eh_e - target_mm) <= tol_e + calib_tol + FLOAT_CMP_EPS:
                return True
        return False

    calib_matches = [i for i, s in enumerate(closed_all) if is_square_of_size(s, calib_size, calib_tol)]
    calib_layer_matches = [i for i in calib_matches if is_calibration_layer_name(closed_all[i].get("layer"))]
    if calib_layer_matches:
        excluded_indices.add(calib_layer_matches[0])
    elif calib_matches:
        if (
            expectations.get("requireCalibrationSquare", True)
            or len(calib_matches) >= 2
            or not any_expected_matches_square(calib_size)
        ):
            excluded_indices.add(calib_matches[0])

    twoin_matches = [
        i for i, s in enumerate(closed_all)
        if i not in excluded_indices and is_square_of_size(s, 50.8, calib_tol)
    ]
    twoin_layer_matches = [i for i in twoin_matches if is_calibration_layer_name(closed_all[i].get("layer"))]
    if twoin_layer_matches:
        excluded_indices.add(twoin_layer_matches[0])
    elif twoin_matches:
        if (
            expectations.get("require2InCalibrationSquare", False)
            or len(twoin_matches) >= 2
            or not any_expected_matches_square(50.8)
        ):
            excluded_indices.add(twoin_matches[0])

    closed_shapes = [s for i, s in enumerate(closed_all) if i not in excluded_indices]

    dup_pool: set = set()
    if check_cut_duplicates:
        cut_closed_indices = {
            s_idx for s_idx, s in enumerate(closed_shapes)
            if is_cut_layer_name(s.get("layer"))
        }
        has_seam_layer = any(is_seam_layer_name(s.get("layer")) for s in closed_shapes)
        dup_pool = (
            cut_closed_indices
            if (cut_closed_indices or has_seam_layer)
            else set(range(len(closed_shapes)))
        )

    adj: List[List[int]] = []
    best_descs: List[str] = []
    for idx, exp in enumerate(expected_pieces):
        tol = float(exp.get("tolMm", expectations.get("tolMm", 0.1)))
        area_tol_pct = float(exp.get("areaTolPct", expectations.get("areaTolPct", 1.0)))
        ew = exp.get("widthMm")
        eh = exp.get("heightMm")
        ea = exp.get("areaMm2")
        ep = exp.get("perimeterMm")
        allow_swap = bool(exp.get("allowRotate90", False))

        cand_scores: List[Tuple[float, int]] = []
        best_desc = "none"
        best_score = float("inf")
        for s_idx, s in enumerate(closed_shapes):
            score = 0.0
            ok = True
            if ew is not None and eh is not None:
                d_normal = max(abs(s["widthMm"] - ew), abs(s["heightMm"] - eh))
                d_swap = max(abs(s["widthMm"] - eh), abs(s["heightMm"] - ew))
                d = min(d_normal, d_swap) if allow_swap else d_normal
                score += d
                if d > tol + FLOAT_CMP_EPS:
                    ok = False
            elif ew is not None:
                d = abs(s["widthMm"] - ew)
                score += d
                if d > tol + FLOAT_CMP_EPS:
                    ok = False
            elif eh is not None:
                d = abs(s["heightMm"] - eh)
                score += d
                if d > tol + FLOAT_CMP_EPS:
                    ok = False

            if ea is not None:
                da = abs(s["areaMm2"] - ea)
                max_a = max(1.0, abs(ea) * (area_tol_pct / 100.0))
                score += da / max(1.0, abs(ea)) * 100.0
                if da > max_a + FLOAT_CMP_EPS:
                    ok = False

            if ep is not None:
                dp = abs(s["perimeterMm"] - ep)
                max_p = max(tol * 4.0, abs(ep) * 0.005)
                score += dp
                if dp > max_p + FLOAT_CMP_EPS:
                    ok = False

            if score < best_score:
                best_score = score
                best_desc = f"w={s['widthMm']:.3f},h={s['heightMm']:.3f},area={s['areaMm2']:.2f},perim={s['perimeterMm']:.2f}"
            if ok:
                cand_scores.append((score, s_idx))

        cand_scores.sort(key=lambda item: (0 if item[1] in dup_pool else 1, item[0], item[1]))
        adj.append([s_idx for _, s_idx in cand_scores])
        best_descs.append(best_desc)

    shape_to_exp: Dict[int, int] = {}
    exp_matched: Dict[int, int] = {}

    def try_augment(u: int, visited: set) -> bool:
        for v in adj[u]:
            if v in visited:
                continue
            visited.add(v)
            if v not in shape_to_exp or try_augment(shape_to_exp[v], visited):
                shape_to_exp[v] = u
                exp_matched[u] = v
                return True
        return False

    # Process tighter-constrained expectations (fewer matching shapes) first
    order = sorted(range(len(expected_pieces)), key=lambda idx: (len(adj[idx]), idx))
    for u in order:
        try_augment(u, set())

    for idx, exp in enumerate(expected_pieces):
        if idx not in exp_matched:
            tol = float(exp.get("tolMm", expectations.get("tolMm", 0.1)))
            errors.append(
                f"Expected piece[{idx}] ({exp}) not matched within {tol} mm (closed candidates={len(closed_shapes)}, closest={best_descs[idx]})"
            )

    if check_cut_duplicates and dup_pool:
        for exp_idx, matched_s_idx in exp_matched.items():
            if matched_s_idx not in dup_pool:
                continue
            extra_cut_dups = [
                s_idx for s_idx in adj[exp_idx]
                if s_idx in dup_pool and s_idx not in shape_to_exp
            ]
            if extra_cut_dups:
                errors.append(
                    f"Duplicate/extra cut-layer shape(s) ({len(extra_cut_dups)} unmatched) match expected piece[{exp_idx}] ({expected_pieces[exp_idx]})"
                )


def verify_svg(file_path: str, expectations: Dict[str, Any]) -> Tuple[List[str], Dict[str, Any]]:
    errors: List[str] = []
    try:
        geom = extract_svg_geometry(file_path, coord_scale=1.0)
    except Exception as exc:
        return [f"SVG XML parse error: {exc}"], {}

    w_mm = geom["widthMm"]
    h_mm = geom["heightMm"]
    vb = geom["viewBox"]
    check_scale = expectations.get("checkScale1to1", True)

    if check_scale:
        if w_mm is None or h_mm is None:
            errors.append("SVG missing valid width/height attributes with physical units (expected mm)")
        elif geom["widthUnit"] != "mm" or geom["heightUnit"] != "mm":
            errors.append(
                f"SVG width/height must use 'mm' units for 1:1 physical export (got '{geom['widthUnit']}', '{geom['heightUnit']}')"
            )
        if vb is None:
            errors.append("SVG missing valid viewBox attribute")
        elif w_mm is not None and h_mm is not None:
            if abs(w_mm - vb[2]) > 0.1 + FLOAT_CMP_EPS or abs(h_mm - vb[3]) > 0.1 + FLOAT_CMP_EPS:
                errors.append(
                    f"SVG 1:1 scale mismatch: width/height=({w_mm:.3f}x{h_mm:.3f}mm) vs viewBox=({vb[2]:.3f}x{vb[3]:.3f})"
                )

    calib_size = float(expectations.get("calibSizeMm", 50.0))
    calib_tol = float(expectations.get("calibTolMm", 0.1))
    require_calib = expectations.get("requireCalibrationSquare", True)
    require_2in = expectations.get("require2InCalibrationSquare", False)

    shapes = geom["shapes"]
    closed_shapes = [s for s in shapes if s["closed"]]
    calib_50 = [s for s in closed_shapes if is_square_of_size(s, calib_size, calib_tol)]
    calib_2in = [s for s in closed_shapes if is_square_of_size(s, 50.8, calib_tol)]

    if require_calib and not calib_50:
        errors.append(f"Missing {calib_size} ± {calib_tol} mm calibration square in SVG")
    if require_2in and not calib_2in:
        errors.append(f"Missing 50.8 ± {calib_tol} mm (2in) calibration square in SVG")

    expected_layers = expectations.get("expectedLayers") or []
    if expected_layers:
        layer_str = " ".join(geom["layers"]).lower()
        for lyr in expected_layers:
            if str(lyr).lower() not in layer_str:
                errors.append(f"Expected SVG semantic layer '{lyr}' not found in <g> layers {geom['layers']}")

    min_closed = expectations.get("minClosedShapes")
    if min_closed is not None and len(closed_shapes) < int(min_closed):
        errors.append(f"Expected >= {min_closed} closed shapes in SVG, got {len(closed_shapes)}")

    check_self_intersection = expectations.get("checkSelfIntersection", True)
    self_intersecting_count = 0
    if check_self_intersection:
        for s_idx, s in enumerate(closed_shapes):
            if polygon_self_intersects(s["points"]):
                self_intersecting_count += 1
                errors.append(
                    f"SVG closed shape[{s_idx}] (layer={s.get('layer') or 'none'}, w={s['widthMm']:.2f}x{s['heightMm']:.2f}mm) self-intersects"
                )
        for s_idx, s in enumerate(shapes):
            if not s["closed"] and s.get("tag") in ("path", "polyline"):
                pts = s["points"]
                if len(pts) >= 4 and math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) <= 0.15 + FLOAT_CMP_EPS:
                    if polygon_self_intersects(pts):
                        self_intersecting_count += 1
                        errors.append(
                            f"SVG near-closed shape[{s_idx}] (layer={s.get('layer') or 'none'}, w={s['widthMm']:.2f}x{s['heightMm']:.2f}mm) self-intersects"
                        )

    cut_layer_shapes = [s for s in shapes if is_cut_layer_name(s.get("layer"))]
    unclosed_cut_shapes = [s for s in cut_layer_shapes if not s["closed"]]
    if unclosed_cut_shapes:
        errors.append(
            f"SVG cut-lines layer contains {len(unclosed_cut_shapes)} unclosed shape(s) (first w={unclosed_cut_shapes[0]['widthMm']:.2f}x{unclosed_cut_shapes[0]['heightMm']:.2f}mm)"
        )
    cut_layer_closed = [s for s in cut_layer_shapes if s["closed"]]
    seam_layer_closed = [s for s in closed_shapes if is_seam_layer_name(s.get("layer"))]
    if seam_layer_closed and not cut_layer_closed:
        errors.append("SVG has closed seam-lines contours but no closed cut-lines contours")
    elif seam_layer_closed:
        for us in find_unmatched_seam_contours(seam_layer_closed, cut_layer_closed, tol=0.25):
            errors.append(
                f"SVG closed seam-lines contour (w={us['widthMm']:.2f}x{us['heightMm']:.2f}mm) has no matching enclosing closed cut-lines contour"
            )

    check_expected_pieces(shapes, expectations, calib_size, calib_tol, errors, check_cut_duplicates=True)
    max_curve_dev = check_curve_fidelity(shapes, expectations, errors)

    metrics = {
        "widthMm": w_mm,
        "heightMm": h_mm,
        "viewBox": vb,
        "shapeCount": len(shapes),
        "closedShapeCount": len(closed_shapes),
        "calib50Count": len(calib_50),
        "calib2InCount": len(calib_2in),
        "layerCount": len(geom["layers"]),
        "maxCurveDeviationMm": max_curve_dev,
        "selfIntersectingShapes": self_intersecting_count,
    }
    return errors, metrics


def verify_pdf(file_path: str, expectations: Dict[str, Any]) -> Tuple[List[str], Dict[str, Any]]:
    errors: List[str] = []
    with open(file_path, "rb") as f:
        header = f.read(16)
    if not header.startswith(b"%PDF-1.4") and expectations.get("requirePdf14", True):
        errors.append(f"PDF header does not start with %PDF-1.4 (got {header[:10]!r})")
    elif not header.startswith(b"%PDF-"):
        errors.append(f"Invalid PDF header: {header[:10]!r}")

    # 1. pdfinfo
    pinfo = subprocess.run(["pdfinfo", file_path], capture_output=True, text=True, timeout=20)
    if pinfo.returncode != 0:
        errors.append(f"pdfinfo failed: {pinfo.stderr.strip()}")
        return errors, {}

    pages_m = re.search(r"^Pages:\s*(\d+)", pinfo.stdout, re.MULTILINE)
    size_m = re.search(r"^Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts", pinfo.stdout, re.MULTILINE)
    rot_m = re.search(r"^Page rot:\s*(-?\d+)", pinfo.stdout, re.MULTILINE)
    page_count = int(pages_m.group(1)) if pages_m else 0
    page_w_pt = float(size_m.group(1)) if size_m else 0.0
    page_h_pt = float(size_m.group(2)) if size_m else 0.0
    default_rot = int(rot_m.group(1)) if rot_m else 0

    if page_count < 1:
        errors.append(f"PDF has invalid page count: {page_count}")

    pt_to_mm = 25.4 / 72.0
    page_dims_pt: Dict[int, Tuple[float, float]] = {}
    page_rots: Dict[int, int] = {}
    if page_count >= 1:
        pinfo_pages = subprocess.run(
            ["pdfinfo", "-f", "1", "-l", str(page_count), file_path],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if pinfo_pages.returncode == 0:
            for pm_num, pm_w, pm_h in re.findall(
                r"^Page\s+(\d+)\s+size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts",
                pinfo_pages.stdout,
                re.MULTILINE,
            ):
                page_dims_pt[int(pm_num)] = (float(pm_w), float(pm_h))
            for pr_num, pr_deg in re.findall(
                r"^Page\s+(\d+)\s+rot:\s*(-?\d+)",
                pinfo_pages.stdout,
                re.MULTILINE,
            ):
                page_rots[int(pr_num)] = int(pr_deg)
        if (not page_w_pt or not page_h_pt) and 1 in page_dims_pt:
            page_w_pt, page_h_pt = page_dims_pt[1]
        for p in range(1, page_count + 1):
            pw_raw, ph_raw = page_dims_pt.get(p, (page_w_pt, page_h_pt))
            rot_p = page_rots.get(p, default_rot)
            if rot_p % 180 == 90:
                pw_raw, ph_raw = ph_raw, pw_raw
            page_dims_pt[p] = (pw_raw, ph_raw)
        if 1 in page_dims_pt:
            page_w_pt, page_h_pt = page_dims_pt[1]
        elif default_rot % 180 == 90:
            page_w_pt, page_h_pt = page_h_pt, page_w_pt

    page_w_mm = page_w_pt * pt_to_mm
    page_h_mm = page_h_pt * pt_to_mm
    page_dims_mm: Dict[int, Tuple[float, float]] = {
        p: (w * pt_to_mm, h * pt_to_mm) for p, (w, h) in page_dims_pt.items()
    }

    def get_page_dims_mm(p: int) -> Tuple[float, float]:
        return page_dims_mm.get(p, (page_w_mm, page_h_mm))

    fmt = expectations.get("pageFormat")
    if fmt:
        if not isinstance(fmt, str) or fmt.upper() not in PAGE_SIZES_PT:
            errors.append(f"Unsupported expected PDF pageFormat: {fmt!r}")
        else:
            ew, eh = PAGE_SIZES_PT[fmt.upper()]
            allow_land = bool(expectations.get("allowLandscape"))
            pages_to_check = (
                [(p_num, page_dims_pt[p_num]) for p_num in sorted(page_dims_pt.keys())]
                if page_dims_pt
                else [(1, (page_w_pt, page_h_pt))]
            )
            for p_num, (pw, ph) in pages_to_check:
                match_portrait = abs(pw - ew) <= 0.5 and abs(ph - eh) <= 0.5
                match_landscape = abs(pw - eh) <= 0.5 and abs(ph - ew) <= 0.5
                if not (match_portrait or (allow_land and match_landscape)):
                    errors.append(
                        f"PDF page {p_num} size {pw:.2f}x{ph:.2f} pt does not match {fmt.upper()} ({ew}x{eh} pt ± 0.5 pt)"
                    )

    if expectations.get("exactPages") is not None and page_count != int(expectations["exactPages"]):
        errors.append(f"Expected exactly {expectations['exactPages']} PDF pages, got {page_count}")
    if expectations.get("minPages") is not None and page_count < int(expectations["minPages"]):
        errors.append(f"Expected >= {expectations['minPages']} PDF pages, got {page_count}")
    if expectations.get("maxPages") is not None and page_count > int(expectations["maxPages"]):
        errors.append(f"Expected <= {expectations['maxPages']} PDF pages, got {page_count}")

    # 2. Ghostscript bbox sanity check
    gs_res = subprocess.run(
        ["gs", "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=bbox", file_path],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if gs_res.returncode != 0:
        errors.append(f"Ghostscript validation failed (code {gs_res.returncode}): {gs_res.stderr.strip()}")
    gs_combined = gs_res.stdout + "\n" + gs_res.stderr
    has_bbox = "%%HiResBoundingBox:" in gs_combined
    if not has_bbox and expectations.get("requireVectors", True):
        errors.append("Ghostscript produced no %%HiResBoundingBox output")

    # 3. pdftotext
    ptxt = subprocess.run(["pdftotext", file_path, "-"], capture_output=True, text=True, timeout=20)
    if ptxt.returncode != 0:
        errors.append(f"pdftotext failed: {ptxt.stderr.strip()}")
    pdf_text = ptxt.stdout or ""
    for sub in expectations.get("expectedTextSubstrings") or []:
        if sub.lower() not in pdf_text.lower():
            errors.append(f"Expected text substring '{sub}' missing from PDF text")

    # 4. pdftocairo -svg per checked page
    calib_size = float(expectations.get("calibSizeMm", 50.0))
    calib_tol = float(expectations.get("calibTolMm", 0.1))
    require_calib = expectations.get("requireCalibrationSquare", True)
    require_reg = expectations.get("requireRegistrationMarks", page_count > 1)
    require_dashed = expectations.get("requireDashedLines", False)
    require_internal = expectations.get("requireInternalLines", False)

    pages_to_check = list(range(1, page_count + 1))

    all_shapes: List[Dict[str, Any]] = []
    page1_shapes: List[Dict[str, Any]] = []
    page_shapes_by_num: Dict[int, List[Dict[str, Any]]] = {}
    reg_marks_found = 0
    dashed_found = False

    def record_page_shapes(page_num: int, pshapes: List[Dict[str, Any]]) -> None:
        nonlocal page1_shapes, reg_marks_found, dashed_found
        page_shapes_by_num[page_num] = pshapes
        if page_num == 1:
            page1_shapes = pshapes
        all_shapes.extend(pshapes)
        if any(s["dashed"] for s in pshapes):
            dashed_found = True
        pw_mm, ph_mm = get_page_dims_mm(page_num)
        for s in pshapes:
            if is_corner_reg_mark(s, pw_mm, ph_mm, calib_size, calib_tol, pshapes=pshapes):
                reg_marks_found += 1

    def extract_page_range_batched(start_p: int, end_p: int, tag: str, tmpd: str) -> bool:
        if end_p <= start_p:
            return False
        batch_svg = os.path.join(tmpd, f"batch_{tag}.svg")
        c_res = subprocess.run(
            [
                "pdftocairo", "-svg", "-origpagesizes", "-noshrink",
                "-f", str(start_p), "-l", str(end_p),
                file_path, batch_svg,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if c_res.returncode != 0 or not os.path.exists(batch_svg):
            return False
        try:
            parser = ET.XMLParser(resolve_entities=False)
            tree = ET.parse(batch_svg, parser)
            root = tree.getroot()
            page_elems = [el for el in root.iter() if local_tag(el.tag) == "page"]
            if len(page_elems) != (end_p - start_p + 1):
                return False
            parsed_pages: List[Tuple[int, List[Dict[str, Any]]]] = []
            for idx_p, page_el in enumerate(page_elems):
                pnum = start_p + idx_p
                pshapes, _ = extract_svg_elements_geometry(page_el, coord_scale=pt_to_mm)
                parsed_pages.append((pnum, pshapes))
            for pnum, pshapes in parsed_pages:
                record_page_shapes(pnum, pshapes)
            return True
        except Exception:
            return False

    def extract_single_page(p: int, tmpd: str) -> None:
        out_svg = os.path.join(tmpd, f"page_{p}.svg")
        c_res = subprocess.run(
            ["pdftocairo", "-svg", "-origpagesizes", "-noshrink", "-f", str(p), "-l", str(p), file_path, out_svg],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if c_res.returncode != 0 or not os.path.exists(out_svg):
            errors.append(f"pdftocairo -svg failed on page {p}: {c_res.stderr.strip()}")
            return
        geom = extract_svg_geometry(out_svg, coord_scale=pt_to_mm)
        record_page_shapes(p, geom["shapes"])

    with tempfile.TemporaryDirectory(prefix="psv2-pdf-") as tmpd:
        if page_count >= 1:
            size_runs: List[Tuple[int, int]] = []
            run_start = 1
            prev_dim = (round(page_dims_pt[1][0], 1), round(page_dims_pt[1][1], 1))
            for p in range(2, page_count + 1):
                cur_dim = (round(page_dims_pt[p][0], 1), round(page_dims_pt[p][1], 1))
                if cur_dim != prev_dim:
                    size_runs.append((run_start, p - 1))
                    run_start = p
                    prev_dim = cur_dim
            size_runs.append((run_start, page_count))

            batch_ranges: List[Tuple[int, int]] = []
            for r_start, r_end in size_runs:
                cur = r_start
                while cur <= r_end:
                    chunk_end = min(r_end, cur + 63)
                    batch_ranges.append((cur, chunk_end))
                    cur = chunk_end + 1

            for b_idx, (b_start, b_end) in enumerate(batch_ranges):
                if b_end > b_start and extract_page_range_batched(b_start, b_end, f"b{b_idx}_{b_start}_{b_end}", tmpd):
                    continue
                for p in range(b_start, b_end + 1):
                    extract_single_page(p, tmpd)

    page1_calib_50 = [s for s in page1_shapes if is_square_of_size(s, calib_size, calib_tol)]
    if require_calib and not page1_calib_50:
        errors.append(f"Page 1 missing {calib_size} ± {calib_tol} mm calibration square in rendered PDF vectors")

    if page_count > 1 and require_reg and reg_marks_found < 2:
        errors.append(
            f"Multi-page tiled PDF ({page_count} pages) missing corner alignment registration marks (found {reg_marks_found})"
        )

    if require_dashed and not dashed_found:
        errors.append("Expected dashed seam/internal lines in PDF vectors, but none found")

    margin_exp = expectations.get("marginMm")
    expected_overlap = expectations.get("overlapMm", expectations.get("expectedOverlapMm"))
    checked_keys = sorted(page_shapes_by_num.keys())

    def piece_candidates_for_page(
        pshapes: List[Dict[str, Any]],
        pw_mm: float,
        ph_mm: float,
        frame_obj: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        out = []
        for s in pshapes:
            if not s.get("closed"):
                continue
            if is_square_of_size(s, calib_size, calib_tol) or is_square_of_size(s, 50.8, calib_tol):
                continue
            if is_unstroked_page_bg(s, pw_mm, ph_mm):
                continue
            if frame_obj is not None and s is frame_obj:
                continue
            if is_corner_reg_mark(s, pw_mm, ph_mm, calib_size, calib_tol, pshapes=pshapes):
                continue
            if s["widthMm"] >= 9.95 or s["heightMm"] >= 9.95:
                out.append(s)
        return out

    expected_pieces_pdf = list(expectations.get("expectedPieces") or [])
    if any(k in expectations for k in ("expectedWidthMm", "expectedHeightMm", "expectedAreaMm2", "expectedPerimeterMm")):
        expected_pieces_pdf.append({
            "widthMm": expectations.get("expectedWidthMm"),
            "heightMm": expectations.get("expectedHeightMm"),
            "areaMm2": expectations.get("expectedAreaMm2"),
            "perimeterMm": expectations.get("expectedPerimeterMm"),
            "tolMm": expectations.get("tolMm", 0.1),
        })

    info_by_page: Dict[int, Dict[str, Any]] = {}
    pieces_by_page: Dict[int, List[Dict[str, Any]]] = {}
    for pk in checked_keys:
        pw_pk, ph_pk = get_page_dims_mm(pk)
        pw_pt_pk, ph_pt_pk = page_dims_pt.get(pk, (page_w_pt, page_h_pt))
        cdx_pk = 0.5 * (pw_pt_pk - math.ceil(pw_pt_pk)) * pt_to_mm
        cdy_pk = 0.5 * (ph_pt_pk - math.ceil(ph_pt_pk)) * pt_to_mm
        info_pk = extract_tile_marks_and_frame(
            page_shapes_by_num[pk],
            pw_pk,
            ph_pk,
            calib_size,
            calib_tol,
            margin_mm=margin_exp,
            page_count=page_count,
            expected_pieces=expected_pieces_pdf,
            ctm_dx=cdx_pk,
            ctm_dy=cdy_pk,
        )
        info_by_page[pk] = info_pk
        pieces_by_page[pk] = piece_candidates_for_page(page_shapes_by_num[pk], pw_pk, ph_pk, info_pk["frame"])

    _shape_inside_memo: Dict[Tuple[int, int, float], bool] = {}
    _sol_poly_cache: Dict[int, Any] = {}
    _inner_pts_cache: Dict[int, Any] = {}
    _solids_by_page_cache: Dict[int, List[Dict[str, Any]]] = {}
    _enclosing_sols_cache: Dict[Tuple[int, int], List[Dict[str, Any]]] = {}
    _dashed_cross_cache: Dict[Tuple[int, Any, Any], Tuple[set, set]] = {}
    _aux_shapes_cache: Dict[int, List[Dict[str, Any]]] = {}
    _aux_bleed_cache: Dict[Tuple[int, int, str, str, float, Any], bool] = {}
    _ortho_step_cache: Dict[Tuple[str, Any], Optional[float]] = {}
    _axis_step_ov_cache: Dict[Tuple[str, Any], Tuple[Optional[float], Optional[float]]] = {}

    def _get_sol_poly_data(sol: Dict[str, Any]) -> Any:
        sid = id(sol)
        cached = _sol_poly_cache.get(sid)
        if cached is not None:
            return cached
        sol_pts = sol.get("points") or []
        pts = np.asarray(sol_pts, dtype=np.float64)
        qx0 = pts[:, 0]
        qy0 = pts[:, 1]
        qx1 = np.roll(qx0, -1)
        qy1 = np.roll(qy0, -1)
        edx = qx1 - qx0
        edy = qy1 - qy0
        elen2 = edx * edx + edy * edy
        emin_x = np.minimum(qx0, qx1)
        emax_x = np.maximum(qx0, qx1)
        emin_y = np.minimum(qy0, qy1)
        emax_y = np.maximum(qy0, qy1)
        data = (qx0, qy0, qx1, qy1, edx, edy, elen2, emin_x, emax_x, emin_y, emax_y)
        _sol_poly_cache[sid] = data
        return data

    def _get_inner_pts_data(inner: Dict[str, Any]) -> Any:
        iid = id(inner)
        cached = _inner_pts_cache.get(iid)
        if cached is not None:
            return cached
        inner_pts = inner.get("points") or []
        p = np.asarray(inner_pts, dtype=np.float64)
        if len(inner_pts) < 2:
            data = (p, None)
            _inner_pts_cache[iid] = data
            return data
        px0 = p[:, 0]
        py0 = p[:, 1]
        px1 = np.roll(px0, -1)
        py1 = np.roll(py0, -1)
        idx_dx = px1 - px0
        idx_dy = py1 - py0
        fracs = np.array([0.0, 0.25, 0.5, 0.75], dtype=np.float64)
        sx = (px0[:, None] + idx_dx[:, None] * fracs[None, :]).ravel()
        sy = (py0[:, None] + idx_dy[:, None] * fracs[None, :]).ravel()
        imin_x = np.minimum(px0, px1)
        imax_x = np.maximum(px0, px1)
        imin_y = np.minimum(py0, py1)
        imax_y = np.maximum(py0, py1)
        data = (p, (px0, py0, idx_dx, idx_dy, sx, sy, imin_x, imax_x, imin_y, imax_y))
        _inner_pts_cache[iid] = data
        return data

    def _pts_in_or_near_vec(
        sx: np.ndarray,
        sy: np.ndarray,
        sol_data: Any,
        tol: float,
    ) -> bool:
        qx0, qy0, qx1, qy1, edx, edy, elen2, emin_x, emax_x, emin_y, emax_y = sol_data
        tol2 = tol * tol
        n_pts = len(sx)
        safe_dy = np.where(np.abs(edy) > 1e-12, edy, 1e-12)
        safe_len2 = np.where(elen2 > 1e-24, elen2, 1.0)
        for start in range(0, n_pts, 256):
            end = min(n_pts, start + 256)
            px = sx[start:end, None]
            py = sy[start:end, None]
            cond_y = (qy0[None, :] > py) != (qy1[None, :] > py)
            x_int = edx[None, :] * (py - qy0[None, :]) / safe_dy[None, :] + qx0[None, :]
            inside = (np.sum(cond_y & (px < x_int), axis=1) & 1) == 1
            if np.all(inside):
                continue
            out_px = px[~inside]
            out_py = py[~inside]
            near_edge = (
                (out_px >= emin_x[None, :] - tol)
                & (out_px <= emax_x[None, :] + tol)
                & (out_py >= emin_y[None, :] - tol)
                & (out_py <= emax_y[None, :] + tol)
            )
            if not np.all(np.any(near_edge, axis=1)):
                return False
            wx = out_px - qx0[None, :]
            wy = out_py - qy0[None, :]
            t = np.clip((wx * edx[None, :] + wy * edy[None, :]) / safe_len2[None, :], 0.0, 1.0)
            t = np.where(elen2[None, :] > 1e-24, t, 0.0)
            dx_e = out_px - (qx0[None, :] + t * edx[None, :])
            dy_e = out_py - (qy0[None, :] + t * edy[None, :])
            d2 = np.where(near_edge, dx_e * dx_e + dy_e * dy_e, tol2 + 1.0)
            if not np.all(np.min(d2, axis=1) <= tol2):
                return False
        return True

    def _shape_inside_solid_poly(
        inner: Dict[str, Any],
        sol: Dict[str, Any],
        tol: float = 0.2,
    ) -> bool:
        memo_key = (id(inner), id(sol), tol)
        cached = _shape_inside_memo.get(memo_key)
        if cached is not None:
            return cached
        if not (
            sol["minX"] - tol <= inner["minX"]
            and inner["maxX"] <= sol["maxX"] + tol
            and sol["minY"] - tol <= inner["minY"]
            and inner["maxY"] <= sol["maxY"] + tol
        ):
            _shape_inside_memo[memo_key] = False
            return False
        sol_pts = sol.get("points") or []
        inner_pts = inner.get("points") or []
        if len(sol_pts) < 3 or not inner_pts:
            _shape_inside_memo[memo_key] = True
            return True

        sol_data = _get_sol_poly_data(sol)
        p_in, seg_data = _get_inner_pts_data(inner)
        if seg_data is None:
            res = _pts_in_or_near_vec(p_in[:, 0], p_in[:, 1], sol_data, tol)
            _shape_inside_memo[memo_key] = res
            return res

        px0, py0, idx_dx, idx_dy, sx, sy, imin_x, imax_x, imin_y, imax_y = seg_data
        if not _pts_in_or_near_vec(sx, sy, sol_data, tol):
            _shape_inside_memo[memo_key] = False
            return False

        qx0, qy0, _qx1, _qy1, edx, edy, _elen2, emin_x, emax_x, emin_y, emax_y = sol_data
        n_in = len(px0)
        sub_xs: List[float] = []
        sub_ys: List[float] = []
        for c0 in range(0, n_in, 256):
            c1 = min(n_in, c0 + 256)
            ov = (
                (imax_x[c0:c1, None] >= emin_x[None, :] - 1e-6)
                & (imin_x[c0:c1, None] <= emax_x[None, :] + 1e-6)
                & (imax_y[c0:c1, None] >= emin_y[None, :] - 1e-6)
                & (imin_y[c0:c1, None] <= emax_y[None, :] + 1e-6)
            )
            ii_loc, jj = np.nonzero(ov)
            if len(ii_loc) == 0:
                continue
            ii = ii_loc + c0
            ax = idx_dx[ii]
            ay = idx_dy[ii]
            bx = edx[jj]
            by = edy[jj]
            denom = ax * by - ay * bx
            valid_d = np.abs(denom) > 1e-12
            if not np.any(valid_d):
                continue
            ii = ii[valid_d]
            jj = jj[valid_d]
            ax = ax[valid_d]
            ay = ay[valid_d]
            bx = bx[valid_d]
            by = by[valid_d]
            denom = denom[valid_d]
            rx = qx0[jj] - px0[ii]
            ry = qy0[jj] - py0[ii]
            t_hit = (rx * by - ry * bx) / denom
            u_hit = (rx * ay - ry * ax) / denom
            mask = (t_hit > 1e-6) & (t_hit < 1.0 - 1e-6) & (u_hit >= -1e-6) & (u_hit <= 1.0 + 1e-6)
            if not np.any(mask):
                continue
            hits_by_edge: Dict[int, List[float]] = {}
            for ei, tv in zip(ii[mask].tolist(), t_hit[mask].tolist()):
                hits_by_edge.setdefault(ei, []).append(tv)
            for ei, hit_ts in hits_by_edge.items():
                ts = [0.0] + sorted(hit_ts) + [1.0]
                x0_e = float(px0[ei])
                y0_e = float(py0[ei])
                dx_e = float(idx_dx[ei])
                dy_e = float(idx_dy[ei])
                for k in range(len(ts) - 1):
                    t0, t1 = ts[k], ts[k + 1]
                    if t1 - t0 <= 1e-6:
                        continue
                    for frac in (0.25, 0.5, 0.75):
                        tf = t0 + frac * (t1 - t0)
                        sub_xs.append(x0_e + tf * dx_e)
                        sub_ys.append(y0_e + tf * dy_e)

        if sub_xs:
            if not _pts_in_or_near_vec(
                np.asarray(sub_xs, dtype=np.float64),
                np.asarray(sub_ys, dtype=np.float64),
                sol_data,
                tol,
            ):
                _shape_inside_memo[memo_key] = False
                return False

        _shape_inside_memo[memo_key] = True
        return True

    def _get_solids_for_page(pk: int) -> List[Dict[str, Any]]:
        cached = _solids_by_page_cache.get(pk)
        if cached is None:
            cached = [s for s in pieces_by_page[pk] if not s.get("dashed")]
            _solids_by_page_cache[pk] = cached
        return cached

    def _get_enclosing_sols(pk: int, s: Dict[str, Any]) -> List[Dict[str, Any]]:
        key = (pk, id(s))
        cached = _enclosing_sols_cache.get(key)
        if cached is None:
            cached = [
                sol for sol in _get_solids_for_page(pk)
                if _shape_inside_solid_poly(s, sol, tol=0.2)
            ]
            _enclosing_sols_cache[key] = cached
        return cached

    def _grid_coords(pk: int, grid_cfg: Any) -> Optional[Tuple[int, int]]:
        if grid_cfg is None or pk < 1:
            return None
        g_kind, g_cols = grid_cfg
        if g_kind not in ("row", "col") or g_cols is None or not (2 <= g_cols < page_count):
            return None
        if g_kind == "row":
            return ((pk - 1) % g_cols, (pk - 1) // g_cols)
        return ((pk - 1) // g_cols, (pk - 1) % g_cols)

    def _ortho_neighbor_sign(pk: int, qk: int, axis: str, grid_cfg: Any) -> Optional[int]:
        c_pk = _grid_coords(pk, grid_cfg)
        c_qk = _grid_coords(qk, grid_cfg)
        if c_pk is None or c_qk is None:
            return None
        a_idx, o_idx = (0, 1) if axis == "x" else (1, 0)
        if c_pk[a_idx] != c_qk[a_idx]:
            return None
        d_o = c_qk[o_idx] - c_pk[o_idx]
        if abs(d_o) != 1:
            return None
        return d_o

    def _infer_axis_step_and_overlap(target_ax: str, grid_cfg: Any) -> Tuple[Optional[float], Optional[float]]:
        if target_ax in first_step_by_axis and target_ax in first_overlap_by_axis:
            return (first_step_by_axis[target_ax][0], first_overlap_by_axis[target_ax])
        if grid_cfg is None:
            return (first_step_by_axis[target_ax][0] if target_ax in first_step_by_axis else None, first_overlap_by_axis.get(target_ax))
        g_kind, g_cols = grid_cfg
        if g_kind not in ("row", "col") or g_cols is None or not (2 <= g_cols <= page_count):
            return (None, None)
        cache_k = (target_ax, grid_cfg)
        if cache_k in _axis_step_ov_cache:
            return _axis_step_ov_cache[cache_k]
        inner_ax = "x" if g_kind == "row" else "y"
        pairs_o: List[Tuple[int, int]] = []
        if target_ax == inner_ax:
            for pa in range(1, page_count):
                if pa % g_cols != 0 and pa in page_shapes_by_num and (pa + 1) in page_shapes_by_num:
                    pairs_o.append((pa, pa + 1))
        elif g_cols < page_count:
            for pa in range(1, page_count - g_cols + 1):
                if pa in page_shapes_by_num and (pa + g_cols) in page_shapes_by_num:
                    pairs_o.append((pa, pa + g_cols))
        ov_tol_s = max(30.0, float(expected_overlap) + 1.0) if expected_overlap is not None else 30.0
        lo_idx, hi_idx = (0, 2) if target_ax == "x" else (1, 3)
        min_k, max_k = ("minX", "maxX") if target_ax == "x" else ("minY", "maxY")
        cand_entries: List[Tuple[bool, float, float]] = []
        for pa, pb in pairs_o:
            ba = box_by_page.get(pa)
            bb = box_by_page.get(pb)
            if ba is None or bb is None or ba[lo_idx] is None or ba[hi_idx] is None or bb[lo_idx] is None or bb[hi_idx] is None:
                continue
            uba = unshifted_box_by_page.get(pa, ba)
            ubb = unshifted_box_by_page.get(pb, bb)
            ctm_dx = 0.0
            ctm_dy = 0.0
            if pa in page_dims_pt and pb in page_dims_pt:
                pwa_pt, pha_pt = page_dims_pt[pa]
                pwb_pt, phb_pt = page_dims_pt[pb]
                ctm_dx = 0.5 * ((pwa_pt - math.ceil(pwa_pt)) - (pwb_pt - math.ceil(pwb_pt))) * pt_to_mm
                ctm_dy = 0.5 * ((pha_pt - math.ceil(pha_pt)) - (phb_pt - math.ceil(phb_pt))) * pt_to_mm
            raw_pair: List[Tuple[int, int, Dict[str, Any], Dict[str, Any], float, float]] = []
            pa_pieces = pieces_by_page[pa]
            pb_pieces = pieces_by_page[pb]
            for i1, sa in enumerate(pa_pieces):
                sa_pts = sa.get("points") or []
                if not sa_pts:
                    continue
                for i2, sb in enumerate(pb_pieces):
                    if bool(sa.get("dashed")) != bool(sb.get("dashed")):
                        continue
                    if abs(sa["widthMm"] - sb["widthMm"]) > 0.1 + FLOAT_CMP_EPS or abs(sa["heightMm"] - sb["heightMm"]) > 0.1 + FLOAT_CMP_EPS:
                        continue
                    if abs(sa["areaMm2"] - sb["areaMm2"]) > max(1.0, 0.01 * max(sa["areaMm2"], sb["areaMm2"])):
                        continue
                    dx_p = (sa["minX"] - sb["minX"]) - ctm_dx
                    dy_p = (sa["minY"] - sb["minY"]) - ctm_dy
                    sh_perp = dy_p if target_ax == "x" else dx_p
                    step_o = dx_p if target_ax == "x" else dy_p
                    if abs(sh_perp) > 0.1 + FLOAT_CMP_EPS or step_o <= 10.0:
                        continue
                    dx_pos = step_o if target_ax == "x" else abs(sh_perp)
                    dy_pos = abs(sh_perp) if target_ax == "x" else step_o
                    if not is_facing_overflow_match(
                        sa, sb, dx_pos, dy_pos, ba, bb, expected_axis=target_ax, pk_a=None, grid_cfg=None, ubox_a=uba, ubox_b=ubb
                    ):
                        continue
                    imp_ov = (uba[hi_idx] - ubb[lo_idx]) - step_o
                    if imp_ov < -1.0 or imp_ov > ov_tol_s:
                        continue
                    if expected_overlap is not None and abs(imp_ov - float(expected_overlap)) > 1.0:
                        continue
                    sb_pts = sb.get("points") or []
                    if not sb_pts or shifted_polygon_max_error(sa_pts, sb_pts, sa["minX"] - sb["minX"], sa["minY"] - sb["minY"]) > 0.1 + FLOAT_CMP_EPS:
                        continue
                    raw_pair.append((i1, i2, sa, sb, dx_pos, dy_pos))
            if not raw_pair:
                continue
            selected_pair = select_pair_matches(raw_pair, ba, bb, expected_axis=target_ax, ubox_a=uba, ubox_b=ubb)
            for s1, s2, dx_m, dy_m in selected_pair:
                step_m = dx_m if target_ax == "x" else dy_m
                imp_ov_m = (uba[hi_idx] - ubb[lo_idx]) - step_m
                both_cross = (
                    s1[min_k] <= ba[hi_idx] + 1.0
                    and s1[max_k] > ba[hi_idx] + 1.0
                    and s2[max_k] >= bb[lo_idx] - 1.0
                    and s2[min_k] < bb[lo_idx] - 1.0
                )
                cand_entries.append((both_cross, step_m, imp_ov_m))
        res: Tuple[Optional[float], Optional[float]] = (None, None)
        if cand_entries:
            filtered = [(st, ov) for bc, st, ov in cand_entries if bc] if any(bc for bc, _, _ in cand_entries) else [(st, ov) for _, st, ov in cand_entries]
            pref_ov = float(expected_overlap) if expected_overlap is not None else 10.0
            best_cluster: Optional[List[Tuple[float, float]]] = None
            best_rank: Optional[Tuple[int, float]] = None
            for st_c, _ in filtered:
                cluster = [(st2, ov2) for st2, ov2 in filtered if abs(st2 - st_c) <= 0.2]
                ov_sorted = sorted(ov2 for _, ov2 in cluster)
                med_ov = ov_sorted[len(ov_sorted) // 2]
                rank = (-len(cluster), abs(med_ov - pref_ov))
                if best_rank is None or rank < best_rank:
                    best_rank = rank
                    best_cluster = cluster
            if best_cluster:
                sts = sorted(st2 for st2, _ in best_cluster)
                ovs = sorted(ov2 for _, ov2 in best_cluster)
                med_step = sts[len(sts) // 2]
                med_ov = ovs[len(ovs) // 2]
                res = (med_step, med_ov)
        if target_ax in first_step_by_axis and res[0] is None:
            res = (first_step_by_axis[target_ax][0], first_overlap_by_axis.get(target_ax))
        _axis_step_ov_cache[cache_k] = res
        return res

    def _infer_ortho_step(ortho_ax: str, grid_cfg: Any) -> Optional[float]:
        if ortho_ax in first_step_by_axis:
            return first_step_by_axis[ortho_ax][0]
        if grid_cfg is None:
            return None
        g_kind, g_cols = grid_cfg
        if g_kind not in ("row", "col") or g_cols is None or not (2 <= g_cols < page_count):
            return None
        cache_k = (ortho_ax, grid_cfg)
        if cache_k in _ortho_step_cache:
            return _ortho_step_cache[cache_k]
        found_step, _ = _infer_axis_step_and_overlap(ortho_ax, grid_cfg)
        _ortho_step_cache[cache_k] = found_step
        return found_step

    def _infer_axis_overlap(target_ax: str, grid_cfg: Any) -> Optional[float]:
        if target_ax in first_overlap_by_axis:
            return first_overlap_by_axis[target_ax]
        _, found_ov = _infer_axis_step_and_overlap(target_ax, grid_cfg)
        return found_ov

    def _get_dashed_in_crossing_solid(
        pk: int,
        box_pk: Tuple[Optional[float], Optional[float], Optional[float], Optional[float]],
        grid_cfg: Any = None,
    ) -> Tuple[set, set]:
        cache_key = (pk, box_pk, grid_cfg if page_has_margin_bleed.get(pk, False) else None)
        cached = _dashed_cross_cache.get(cache_key)
        if cached is not None:
            return cached
        solids_pk = _get_solids_for_page(pk)
        dx_set = {
            id(s) for s in pieces_by_page[pk]
            if s.get("dashed")
            and box_pk[2] is not None
            and s["maxX"] > box_pk[2] + 1.0
            and any(
                (
                    sol["minX"] <= box_pk[2] + 2.5
                    or _piece_has_aux_bleed(pk, sol, "x", "max", box_pk[2], grid_cfg=grid_cfg)
                )
                and sol["maxX"] > box_pk[2] + 1.0
                and _shape_inside_solid_poly(s, sol, tol=0.2)
                for sol in solids_pk
            )
        }
        dy_set = {
            id(s) for s in pieces_by_page[pk]
            if s.get("dashed")
            and box_pk[3] is not None
            and s["maxY"] > box_pk[3] + 1.0
            and any(
                (
                    sol["minY"] <= box_pk[3] + 2.5
                    or _piece_has_aux_bleed(pk, sol, "y", "max", box_pk[3], grid_cfg=grid_cfg)
                )
                and sol["maxY"] > box_pk[3] + 1.0
                and _shape_inside_solid_poly(s, sol, tol=0.2)
                for sol in solids_pk
            )
        }
        cached = (dx_set, dy_set)
        _dashed_cross_cache[cache_key] = cached
        return cached

    def _get_aux_shapes_for_page(pk: int) -> List[Dict[str, Any]]:
        cached = _aux_shapes_cache.get(pk)
        if cached is not None:
            return cached
        pw_pk, ph_pk = get_page_dims_mm(pk)
        fr_pk = info_by_page[pk]["frame"]
        pshapes = page_shapes_by_num[pk]
        out: List[Dict[str, Any]] = []
        for a in pshapes:
            if a.get("closed"):
                continue
            pts = a.get("points") or []
            if len(pts) < 2:
                continue
            if fr_pk is not None and a is fr_pk:
                continue
            if is_unstroked_page_bg(a, pw_pk, ph_pk):
                continue
            if is_tile_border_shape(
                a, pw_pk, ph_pk,
                margin_mm=margin_exp,
                calib_size=calib_size,
                calib_tol=calib_tol,
                has_reg_marks=bool(info_by_page[pk]["regMarks"]),
                page_count=page_count,
            ):
                continue
            if is_corner_reg_mark(a, pw_pk, ph_pk, calib_size, calib_tol, pshapes=pshapes):
                continue
            out.append(a)
        _aux_shapes_cache[pk] = out
        return out

    def _aux_attached_to_piece(aux: Dict[str, Any], s: Dict[str, Any]) -> bool:
        if (
            aux["maxX"] < s["minX"] - 0.5
            or aux["minX"] > s["maxX"] + 0.5
            or aux["maxY"] < s["minY"] - 0.5
            or aux["minY"] > s["maxY"] + 0.5
        ):
            return False
        s_pts = s.get("points") or []
        a_pts = aux.get("points") or []
        n_s = len(s_pts)
        if n_s < 3 or len(a_pts) < 2:
            return False
        test_pts: List[Tuple[float, float]] = list(a_pts)
        for i in range(len(a_pts) - 1):
            test_pts.append((0.5 * (a_pts[i][0] + a_pts[i + 1][0]), 0.5 * (a_pts[i][1] + a_pts[i + 1][1])))
        for px, py in test_pts:
            if not (s["minX"] - 0.5 <= px <= s["maxX"] + 0.5 and s["minY"] - 0.5 <= py <= s["maxY"] + 0.5):
                continue
            if point_in_polygon(px, py, s_pts):
                return True
            for k in range(n_s):
                pa = s_pts[k]
                pb = s_pts[(k + 1) % n_s]
                if point_to_segment_dist(px, py, pa[0], pa[1], pb[0], pb[1]) <= 0.5:
                    return True
        for i in range(len(a_pts) - 1):
            a1, a2 = a_pts[i], a_pts[i + 1]
            for k in range(n_s):
                if segments_intersect_2d(a1, a2, s_pts[k], s_pts[(k + 1) % n_s], eps=1e-5):
                    return True
        return False

    def _piece_has_aux_bleed(
        pk: int,
        s: Dict[str, Any],
        axis: str,
        side: str,
        bound_val: float,
        grid_cfg: Any = None,
    ) -> bool:
        key = (pk, id(s), axis, side, round(bound_val, 3), grid_cfg)
        cached = _aux_bleed_cache.get(key)
        if cached is not None:
            return cached
        min_k, max_k = ("minX", "maxX") if axis == "x" else ("minY", "maxY")
        dist_out = (bound_val - s[max_k]) if side == "min" else (s[min_k] - bound_val)
        if dist_out > 18.0:
            _aux_bleed_cache[key] = False
            return False

        def _aux_reaches(aux_obj: Dict[str, Any], shift: float = 0.0) -> bool:
            if side == "min":
                return (aux_obj[max_k] + shift) >= bound_val - 2.2
            return (aux_obj[min_k] + shift) <= bound_val + 2.2

        for aux in _get_aux_shapes_for_page(pk):
            if _aux_reaches(aux, 0.0) and _aux_attached_to_piece(aux, s):
                _aux_bleed_cache[key] = True
                return True

        s_pts = s.get("points") or []
        if s_pts:
            box_pk = box_by_page.get(pk)
            o_min_k, o_max_k = ("minY", "maxY") if axis == "x" else ("minX", "maxX")
            o_lo_idx, o_hi_idx = (1, 3) if axis == "x" else (0, 2)
            ortho_ax = "y" if axis == "x" else "x"
            ov_tol_b = max(30.0, float(expected_overlap) + 1.0) if expected_overlap is not None else 30.0
            u_step = _infer_ortho_step(ortho_ax, grid_cfg)
            inferred_ov: Optional[float] = None
            if expected_overlap is None:
                inferred_ov = _infer_axis_overlap(ortho_ax, grid_cfg)
                if inferred_ov is None:
                    inferred_ov = _infer_axis_overlap(axis, grid_cfg)
            target_ov = float(expected_overlap) if expected_overlap is not None else inferred_ov
            pw_pk_b, ph_pk_b = get_page_dims_mm(pk)
            ortho_dim_pk = ph_pk_b if axis == "x" else pw_pk_b
            for qk in checked_keys:
                if qk == pk:
                    continue
                d_o = _ortho_neighbor_sign(pk, qk, axis, grid_cfg)
                if d_o is None:
                    continue
                aux_qk = _get_aux_shapes_for_page(qk)
                if not aux_qk:
                    continue
                box_qk = box_by_page.get(qk)
                for st in _get_solids_for_page(qk):
                    if (
                        abs(st["widthMm"] - s["widthMm"]) > 0.25
                        or abs(st["heightMm"] - s["heightMm"]) > 0.25
                        or abs(st["areaMm2"] - s["areaMm2"]) > max(1.0, 0.02 * s["areaMm2"])
                    ):
                        continue
                    dx_align = s["minX"] - st["minX"]
                    dy_align = s["minY"] - st["minY"]
                    sh_axis = dx_align if axis == "x" else dy_align
                    ortho_shift = dy_align if axis == "x" else dx_align
                    if abs(sh_axis) > 0.15 + FLOAT_CMP_EPS or abs(ortho_shift) <= 10.0:
                        continue
                    if d_o * ortho_shift <= 0.0:
                        continue
                    has_ortho_boxes = (
                        box_pk is not None
                        and box_qk is not None
                        and box_pk[o_lo_idx] is not None
                        and box_pk[o_hi_idx] is not None
                        and box_qk[o_lo_idx] is not None
                        and box_qk[o_hi_idx] is not None
                    )
                    eff_u_step = u_step
                    if eff_u_step is None and target_ov is not None and has_ortho_boxes:
                        ortho_span_pk = box_pk[o_hi_idx] - box_pk[o_lo_idx]
                        ortho_span_qk = box_qk[o_hi_idx] - box_qk[o_lo_idx]
                        if abs(ortho_span_pk - ortho_span_qk) <= 1.0:
                            eff_u_step = ortho_span_pk - target_ov
                    if eff_u_step is not None and eff_u_step > 10.0:
                        if abs(abs(ortho_shift) - eff_u_step) > 1.0:
                            continue
                    if has_ortho_boxes:
                        ortho_span_pk = box_pk[o_hi_idx] - box_pk[o_lo_idx]
                        ortho_span_qk = box_qk[o_hi_idx] - box_qk[o_lo_idx]
                        imp_ov_b = (
                            (box_pk[o_hi_idx] - box_qk[o_lo_idx]) if d_o > 0 else (box_qk[o_hi_idx] - box_pk[o_lo_idx])
                        ) - abs(ortho_shift)
                        if imp_ov_b < -1.0 or imp_ov_b > ov_tol_b:
                            continue
                        if target_ov is not None and abs(imp_ov_b - target_ov) > 1.0:
                            continue
                        if eff_u_step is None and abs(ortho_shift) < 0.55 * min(ortho_span_pk, ortho_span_qk) - 1.0:
                            continue
                    st_pts = st.get("points") or []
                    if not st_pts or shifted_polygon_max_error(s_pts, st_pts, dx_align, dy_align) > 0.1 + FLOAT_CMP_EPS:
                        continue
                    attached_reaching = [
                        aux for aux in aux_qk
                        if _aux_reaches(aux, sh_axis) and _aux_attached_to_piece(aux, st)
                    ]
                    if not attached_reaching:
                        continue
                    if has_ortho_boxes:
                        st_max_o = max([st[o_max_k]] + [a[o_max_k] for a in attached_reaching])
                        st_min_o = min([st[o_min_k]] + [a[o_min_k] for a in attached_reaching])
                        if ortho_shift < -10.0:
                            if st_max_o < box_qk[o_hi_idx] - 2.2 or s[o_min_k] > box_pk[o_lo_idx] + 2.2:
                                continue
                            if u_step is None and st_max_o <= box_qk[o_hi_idx] + 1.0 and s[o_min_k] >= box_pk[o_lo_idx] - 1.0:
                                continue
                        else:
                            if s[o_max_k] < box_pk[o_hi_idx] - 2.2 or st_min_o > box_qk[o_lo_idx] + 2.2:
                                continue
                            if u_step is None and s[o_max_k] <= box_pk[o_hi_idx] + 1.0 and st_min_o >= box_qk[o_lo_idx] - 1.0:
                                continue
                    for aux in attached_reaching:
                        if (
                            box_pk is not None
                            and box_pk[o_lo_idx] is not None
                            and box_pk[o_hi_idx] is not None
                        ):
                            aux_o_min = aux[o_min_k] + ortho_shift
                            aux_o_max = aux[o_max_k] + ortho_shift
                            culled_in_pk_dir = (
                                (
                                    (d_o < 0 and aux_o_max <= box_pk[o_lo_idx] + 0.1 + FLOAT_CMP_EPS)
                                    or (d_o > 0 and aux_o_min >= box_pk[o_hi_idx] - 0.1 - FLOAT_CMP_EPS)
                                )
                                and box_qk is not None
                                and box_qk[o_lo_idx] is not None
                                and box_qk[o_hi_idx] is not None
                                and aux[o_max_k] >= box_qk[o_lo_idx] - 2.2
                                and aux[o_min_k] <= box_qk[o_hi_idx] + 2.2
                            )
                            if not culled_in_pk_dir:
                                continue
                        _aux_bleed_cache[key] = True
                        return True

        _aux_bleed_cache[key] = False
        return False

    # Clear misclassified frame if an identical rectangle appears shifted on another page,
    # or on multi-page frameless PDFs (marginMm=None, <1 regMarks) unless the frame repeats
    # identically across >= 2 pages.
    if page_count > 1:
        def _own_frame_corner_indices(
            fr_obj: Dict[str, Any],
            rmarks: List[Dict[str, Any]],
            tol: float = 1.5,
        ) -> set:
            corners = [
                (fr_obj["minX"], fr_obj["minY"]),
                (fr_obj["maxX"], fr_obj["minY"]),
                (fr_obj["minX"], fr_obj["maxY"]),
                (fr_obj["maxX"], fr_obj["maxY"]),
            ]
            hit = set()
            for r in rmarks:
                rcx = 0.5 * (r["minX"] + r["maxX"])
                rcy = 0.5 * (r["minY"] + r["maxY"])
                for c_idx, (cx, cy) in enumerate(corners):
                    if abs(rcx - cx) <= tol and abs(rcy - cy) <= tol:
                        hit.add(c_idx)
            return hit

        def _qk_has_4_matching_corners(
            fr_pk: Dict[str, Any],
            left_m_pk: float,
            top_m_pk: float,
            qk: int,
            pw_qk: float,
            ph_qk: float,
        ) -> bool:
            info_qk = info_by_page[qk]
            rmarks_qk = info_qk["regMarks"]
            rx0 = info_qk["regXMin"]
            rx1 = info_qk["regXMax"]
            ry0 = info_qk["regYMin"]
            ry1 = info_qk["regYMax"]
            if (
                rx0 is None or rx1 is None or ry0 is None or ry1 is None
                or (rx1 - rx0) <= 10.0 or (ry1 - ry0) <= 10.0
            ):
                return False
            rect_qk = {"minX": rx0, "minY": ry0, "maxX": rx1, "maxY": ry1}
            if len(_own_frame_corner_indices(rect_qk, rmarks_qk, tol=1.5)) != 4:
                return False
            matches_fr = (
                abs(rx0 - fr_pk["minX"]) <= 1.5
                and abs(rx1 - fr_pk["maxX"]) <= 1.5
                and abs(ry0 - fr_pk["minY"]) <= 1.5
                and abs(ry1 - fr_pk["maxY"]) <= 1.5
            )
            matches_sym_margins = (
                abs(rx0 - (pw_qk - rx1)) <= 1.5
                and abs(ry0 - (ph_qk - ry1)) <= 1.5
                and abs(rx0 - left_m_pk) <= 1.5
                and abs(ry0 - top_m_pk) <= 1.5
            )
            return matches_fr or matches_sym_margins

        def _frame_norm_margins(fr_obj: Dict[str, Any], pk_num: int) -> Tuple[float, float, float, float]:
            pw_p, ph_p = get_page_dims_mm(pk_num)
            pw_pt_p, ph_pt_p = page_dims_pt.get(pk_num, (page_w_pt, page_h_pt))
            cdx = 0.5 * (pw_pt_p - math.ceil(pw_pt_p)) * pt_to_mm
            cdy = 0.5 * (ph_pt_p - math.ceil(ph_pt_p)) * pt_to_mm
            return (
                fr_obj["minX"] - cdx,
                pw_p - (fr_obj["maxX"] - cdx),
                fr_obj["minY"] - cdy,
                ph_p - (fr_obj["maxY"] - cdy),
            )

        def _is_sym_border_margins(margins: Tuple[float, float, float, float]) -> bool:
            lx, rx, ty, by = margins
            return (
                -0.5 <= lx <= 35.0
                and -0.5 <= ty <= 35.0
                and abs(lx - rx) <= 1.5
                and abs(ty - by) <= 1.5
            )

        def _same_norm_margins(m1: Tuple[float, float, float, float], m2: Tuple[float, float, float, float], tol: float = 0.5) -> bool:
            return all(abs(a - b) <= tol for a, b in zip(m1, m2))

        def _fr_encloses_solid(fr_obj: Dict[str, Any], pk_num: int) -> bool:
            return any(
                not s.get("dashed")
                and (min(s["maxX"], fr_obj["maxX"]) - max(s["minX"], fr_obj["minX"])) > 1.0
                and (min(s["maxY"], fr_obj["maxY"]) - max(s["minY"], fr_obj["minY"])) > 1.0
                for s in pieces_by_page[pk_num]
            )

        orig_frames = {pk: info_by_page[pk]["frame"] for pk in checked_keys}
        orig_frame_margins = {
            pk: (_frame_norm_margins(orig_frames[pk], pk) if orig_frames[pk] is not None else None)
            for pk in checked_keys
        }
        pages_to_clear_frame: List[int] = []
        for pk in checked_keys:
            fr_pk = orig_frames[pk]
            if fr_pk is None:
                continue
            has_reg_pk = len(info_by_page[pk]["regMarks"]) >= 1
            pw_pk, ph_pk = get_page_dims_mm(pk)
            own_corners_pk = len(_own_frame_corner_indices(fr_pk, info_by_page[pk]["regMarks"], tol=1.5))
            has_own_corner_regs_pk = has_reg_pk and own_corners_pk >= 1
            norm_m_pk = orig_frame_margins[pk]
            left_m_pk, right_m_pk, top_m_pk, bottom_m_pk = norm_m_pk
            has_sym_margins_pk = (
                2.0 <= left_m_pk <= 35.0
                and 2.0 <= top_m_pk <= 35.0
                and abs(left_m_pk - right_m_pk) <= 1.5
                and abs(top_m_pk - bottom_m_pk) <= 1.5
            )
            fr_encloses_solid_pk = _fr_encloses_solid(fr_pk, pk)
            non_frame_solids_pk = [s for s in pieces_by_page[pk] if not s.get("dashed")]
            fr_dashed_pk = [
                s for s in pieces_by_page[pk]
                if s.get("dashed")
                and not any(
                    (sol["widthMm"] < fr_pk["widthMm"] - 0.5 or sol["heightMm"] < fr_pk["heightMm"] - 0.5)
                    and _shape_inside_solid_poly(s, sol, tol=0.2)
                    for sol in non_frame_solids_pk
                )
            ]
            has_valid_shifted_with_dashed_pk = False
            has_only_culled_dashed_shift_pk = False
            shifted_on_other = False
            shifted_onto_unframed_qk = False
            shifted_onto_4corner_qk = False
            shifted_onto_framed_qk = False
            repeated_on_other = False
            pw_pk_pt, ph_pk_pt = page_dims_pt.get(pk, (page_w_pt, page_h_pt))
            for qk in checked_keys:
                if qk == pk:
                    continue
                fr_qk = orig_frames[qk]
                same_frame_pos_qk = fr_qk is not None and (
                    abs(fr_qk["minX"] - fr_pk["minX"]) <= 0.5
                    and abs(fr_qk["minY"] - fr_pk["minY"]) <= 0.5
                    and abs(fr_qk["maxX"] - fr_pk["maxX"]) <= 0.5
                    and abs(fr_qk["maxY"] - fr_pk["maxY"]) <= 0.5
                )
                same_norm_margins_qk = (
                    fr_qk is not None
                    and orig_frame_margins[qk] is not None
                    and _same_norm_margins(orig_frame_margins[qk], norm_m_pk, tol=0.5)
                )
                if fr_qk is not None and (
                    same_frame_pos_qk
                    or same_norm_margins_qk
                    or (
                        margin_exp is not None
                        and abs(fr_qk["widthMm"] - (get_page_dims_mm(qk)[0] - 2.0 * float(margin_exp))) <= 2.0
                        and abs(fr_qk["heightMm"] - (get_page_dims_mm(qk)[1] - 2.0 * float(margin_exp))) <= 2.0
                    )
                ):
                    repeated_on_other = True
                pw_qk, ph_qk = get_page_dims_mm(qk)
                pw_qk_pt, ph_qk_pt = page_dims_pt.get(qk, (page_w_pt, page_h_pt))
                ctm_dx_pq = 0.5 * ((pw_pk_pt - math.ceil(pw_pk_pt)) - (pw_qk_pt - math.ceil(pw_qk_pt))) * pt_to_mm
                ctm_dy_pq = 0.5 * ((ph_pk_pt - math.ceil(ph_pk_pt)) - (ph_qk_pt - math.ceil(ph_qk_pt))) * pt_to_mm
                other_cands = list(pieces_by_page[qk])
                if fr_qk is not None:
                    other_cands.append(fr_qk)
                for s2 in other_cands:
                    if bool(fr_pk.get("dashed")) or bool(s2.get("dashed")):
                        continue
                    if (
                        abs(fr_pk["widthMm"] - s2["widthMm"]) > 0.1 + FLOAT_CMP_EPS
                        or abs(fr_pk["heightMm"] - s2["heightMm"]) > 0.1 + FLOAT_CMP_EPS
                    ):
                        continue
                    raw_dx = fr_pk["minX"] - s2["minX"]
                    raw_dy = fr_pk["minY"] - s2["minY"]
                    dx_pq = raw_dx - ctm_dx_pq
                    dy_pq = raw_dy - ctm_dy_pq
                    if min(abs(dx_pq), abs(dy_pq)) > 0.1 + FLOAT_CMP_EPS or max(abs(dx_pq), abs(dy_pq)) <= 10.0:
                        continue
                    if shifted_polygon_max_error(fr_pk["points"], s2["points"], raw_dx, raw_dy) > 0.1 + FLOAT_CMP_EPS:
                        continue
                    shifted_on_other = True
                    if same_frame_pos_qk or same_norm_margins_qk:
                        shifted_onto_framed_qk = True
                    elif fr_qk is None:
                        shifted_onto_unframed_qk = True
                        if _qk_has_4_matching_corners(fr_pk, left_m_pk, top_m_pk, qk, pw_qk, ph_qk):
                            shifted_onto_4corner_qk = True
                    if fr_dashed_pk and not has_valid_shifted_with_dashed_pk:
                        dashed_qk = [d for d in pieces_by_page[qk] if d.get("dashed")]
                        non_culled_dashed = [
                            d1 for d1 in fr_dashed_pk
                            if (d1["maxX"] - raw_dx) >= 0.5
                            and (d1["minX"] - raw_dx) <= pw_qk - 0.5
                            and (d1["maxY"] - raw_dy) >= 0.5
                            and (d1["minY"] - raw_dy) <= ph_qk - 0.5
                        ]
                        if non_culled_dashed and all(
                            any(
                                abs(d1["widthMm"] - d2["widthMm"]) <= 0.1 + FLOAT_CMP_EPS
                                and abs(d1["heightMm"] - d2["heightMm"]) <= 0.1 + FLOAT_CMP_EPS
                                and abs((d1["minX"] - d2["minX"]) - raw_dx) <= 0.1 + FLOAT_CMP_EPS
                                and abs((d1["minY"] - d2["minY"]) - raw_dy) <= 0.1 + FLOAT_CMP_EPS
                                and shifted_polygon_max_error(
                                    d1["points"], d2["points"], d1["minX"] - d2["minX"], d1["minY"] - d2["minY"]
                                ) <= 0.1 + FLOAT_CMP_EPS
                                for d2 in dashed_qk
                            )
                            for d1 in non_culled_dashed
                        ):
                            has_valid_shifted_with_dashed_pk = True
                        elif fr_qk is None and not non_culled_dashed:
                            has_only_culled_dashed_shift_pk = True
            dashed_ok_for_0corners = (
                (has_valid_shifted_with_dashed_pk or has_only_culled_dashed_shift_pk)
                if fr_dashed_pk
                else True
            )
            clean_frameless_shift_pk = (
                own_corners_pk not in (1, 2, 3)
                and not non_frame_solids_pk
                and shifted_onto_unframed_qk
                and not shifted_onto_framed_qk
                and (
                    (has_valid_shifted_with_dashed_pk if fr_dashed_pk else True)
                    if own_corners_pk == 4
                    else dashed_ok_for_0corners
                )
            )
            is_auth_margin_frame_pk = (
                (
                    margin_exp is not None
                    and has_reg_pk
                    and abs(fr_pk["widthMm"] - (pw_pk - 2.0 * float(margin_exp))) <= 2.0
                    and abs(fr_pk["heightMm"] - (ph_pk - 2.0 * float(margin_exp))) <= 2.0
                )
                or (
                    margin_exp is None
                    and not has_valid_shifted_with_dashed_pk
                    and has_own_corner_regs_pk
                    and has_sym_margins_pk
                )
            )
            if is_auth_margin_frame_pk:
                shifted_on_other = False
            def _is_tile_frame_stroke_m(s_obj: Dict[str, Any]) -> bool:
                s_txt = str(s_obj.get("stroke") or "").strip().lower()
                m_pct = re.match(
                    r"rgb\(\s*([0-9.]+)\s*%\s*,\s*([0-9.]+)\s*%\s*,\s*([0-9.]+)\s*%\s*\)",
                    s_txt,
                )
                if not m_pct:
                    return False
                r, g, b = float(m_pct.group(1)) / 100.0, float(m_pct.group(2)) / 100.0, float(m_pct.group(3)) / 100.0
                return 0.55 <= r <= 0.85 and 0.55 <= g <= 0.85 and 0.55 <= b <= 0.85 and (max(r, g, b) - min(r, g, b)) <= 0.08

            non_uniform_non_stroke_fr_pk = (
                norm_m_pk is not None
                and (max(norm_m_pk) - min(norm_m_pk)) > 0.4
                and not _is_tile_frame_stroke_m(fr_pk)
            )
            frameless_outside_piece = False
            crossing_frameless_outside = False
            if margin_exp is None and not has_reg_pk and (not fr_encloses_solid_pk or non_uniform_non_stroke_fr_pk):
                same_frame_pages = [pk] + [
                    qk for qk in checked_keys
                    if qk != pk and orig_frames[qk] is not None
                    and (
                        (
                            abs(orig_frames[qk]["minX"] - fr_pk["minX"]) <= 0.5
                            and abs(orig_frames[qk]["minY"] - fr_pk["minY"]) <= 0.5
                            and abs(orig_frames[qk]["maxX"] - fr_pk["maxX"]) <= 0.5
                            and abs(orig_frames[qk]["maxY"] - fr_pk["maxY"]) <= 0.5
                        )
                        or (
                            orig_frame_margins[qk] is not None
                            and _same_norm_margins(orig_frame_margins[qk], norm_m_pk, tol=0.5)
                        )
                    )
                ]
                any_solid_in_same_frame = any(
                    _fr_encloses_solid(orig_frames[sp_pg], sp_pg)
                    for sp_pg in same_frame_pages
                )
                if not any_solid_in_same_frame:
                    for sp_pg in same_frame_pages:
                        pw_sp, ph_sp = get_page_dims_mm(sp_pg)
                        fr_sp = orig_frames[sp_pg]
                        for s_cand in pieces_by_page[sp_pg]:
                            if s_cand.get("dashed"):
                                continue
                            if (
                                s_cand["minX"] < -0.5
                                or s_cand["maxX"] > pw_sp + 0.5
                                or s_cand["minY"] < -0.5
                                or s_cand["maxY"] > ph_sp + 0.5
                            ):
                                continue
                            if (
                                s_cand["maxX"] <= fr_sp["minX"] + 0.5
                                or s_cand["minX"] >= fr_sp["maxX"] - 0.5
                                or s_cand["maxY"] <= fr_sp["minY"] + 0.5
                                or s_cand["minY"] >= fr_sp["maxY"] - 0.5
                            ):
                                frameless_outside_piece = True
                                break
                        if frameless_outside_piece:
                            break
                if not frameless_outside_piece and (not any_solid_in_same_frame or non_uniform_non_stroke_fr_pk):
                    for i1 in range(len(checked_keys) - 1):
                        p1 = checked_keys[i1]
                        for i2 in range(i1 + 1, len(checked_keys)):
                            p2 = checked_keys[i2]
                            if p1 not in same_frame_pages and p2 not in same_frame_pages:
                                continue
                            pw_p1, ph_p1 = get_page_dims_mm(p1)
                            pw_p2, ph_p2 = get_page_dims_mm(p2)
                            pw_p1_pt, ph_p1_pt = page_dims_pt.get(p1, (page_w_pt, page_h_pt))
                            pw_p2_pt, ph_p2_pt = page_dims_pt.get(p2, (page_w_pt, page_h_pt))
                            ctm_dx_12 = 0.5 * ((pw_p1_pt - math.ceil(pw_p1_pt)) - (pw_p2_pt - math.ceil(pw_p2_pt))) * pt_to_mm
                            ctm_dy_12 = 0.5 * ((ph_p1_pt - math.ceil(ph_p1_pt)) - (ph_p2_pt - math.ceil(ph_p2_pt))) * pt_to_mm
                            for s1 in pieces_by_page[p1]:
                                if s1.get("dashed"):
                                    continue
                                for s2 in pieces_by_page[p2]:
                                    if s2.get("dashed"):
                                        continue
                                    if (
                                        abs(s1["widthMm"] - s2["widthMm"]) > 0.1 + FLOAT_CMP_EPS
                                        or abs(s1["heightMm"] - s2["heightMm"]) > 0.1 + FLOAT_CMP_EPS
                                    ):
                                        continue
                                    area_tol = max(1.0, 0.01 * max(s1["areaMm2"], s2["areaMm2"]))
                                    if abs(s1["areaMm2"] - s2["areaMm2"]) > area_tol:
                                        continue
                                    dx = (s1["minX"] - s2["minX"]) - ctm_dx_12
                                    dy = (s1["minY"] - s2["minY"]) - ctm_dy_12
                                    is_ortho_x = abs(dx) > 10.0 and abs(dy) <= 0.1 + FLOAT_CMP_EPS and (
                                        (s1["maxX"] > pw_p1 + 0.5 and s2["minX"] < -0.5)
                                        or (s2["maxX"] > pw_p2 + 0.5 and s1["minX"] < -0.5)
                                    )
                                    is_ortho_y = abs(dy) > 10.0 and abs(dx) <= 0.1 + FLOAT_CMP_EPS and (
                                        (s1["maxY"] > ph_p1 + 0.5 and s2["minY"] < -0.5)
                                        or (s2["maxY"] > ph_p2 + 0.5 and s1["minY"] < -0.5)
                                    )
                                    if not (is_ortho_x or is_ortho_y):
                                        continue
                                    if expected_overlap is not None:
                                        step_val = abs(dx) if is_ortho_x else abs(dy)
                                        fr_span_val = fr_pk["widthMm"] if is_ortho_x else fr_pk["heightMm"]
                                        src_p = p1 if (dx > 0 if is_ortho_x else dy > 0) else p2
                                        pw_src, ph_src = get_page_dims_mm(src_p)
                                        page_span_val = pw_src if is_ortho_x else ph_src
                                        if not (
                                            abs((page_span_val - step_val) - float(expected_overlap)) <= 0.1 + FLOAT_CMP_EPS
                                            and abs((fr_span_val - step_val) - float(expected_overlap)) > 0.1 + FLOAT_CMP_EPS
                                        ):
                                            continue
                                    crossing_frameless_outside = True
                                    frameless_outside_piece = True
                                    break
                                if frameless_outside_piece:
                                    break
                            if frameless_outside_piece:
                                break
                        if frameless_outside_piece:
                            break
            if own_corners_pk in (1, 2, 3):
                can_clear_pk = False
            elif own_corners_pk == 4:
                can_clear_pk = (
                    not shifted_onto_framed_qk
                    and shifted_onto_4corner_qk
                    and (has_valid_shifted_with_dashed_pk if fr_dashed_pk else True)
                    and (clean_frameless_shift_pk or (has_valid_shifted_with_dashed_pk and not is_auth_margin_frame_pk))
                )
            else:
                other_unframed = any(
                    qk != pk and orig_frames[qk] is None
                    for qk in checked_keys
                )
                other_has_sym_frame = any(
                    qk != pk
                    and orig_frames[qk] is not None
                    and orig_frame_margins[qk] is not None
                    and _is_sym_border_margins(orig_frame_margins[qk])
                    for qk in checked_keys
                )
                can_clear_pk = not shifted_onto_framed_qk and (
                    clean_frameless_shift_pk
                    or (has_valid_shifted_with_dashed_pk and not is_auth_margin_frame_pk)
                    or (shifted_on_other and not repeated_on_other and not is_auth_margin_frame_pk)
                    or (
                        margin_exp is None
                        and not has_reg_pk
                        and (
                            (
                                not fr_encloses_solid_pk
                                and (
                                    frameless_outside_piece
                                    or (not repeated_on_other and other_unframed and not other_has_sym_frame)
                                )
                            )
                            or (
                                non_uniform_non_stroke_fr_pk
                                and crossing_frameless_outside
                            )
                        )
                    )
                )
            if can_clear_pk:
                pages_to_clear_frame.append(pk)
        clearing_set = set(pages_to_clear_frame)
        changed = True
        while changed and clearing_set:
            changed = False
            for pk in list(clearing_set):
                fr_pk = orig_frames[pk]
                if fr_pk is None:
                    continue
                blocked = False
                for qk in checked_keys:
                    if qk == pk or qk in clearing_set:
                        continue
                    fr_qk = orig_frames[qk]
                    if fr_qk is None:
                        continue
                    same_frame_pos = (
                        abs(fr_qk["minX"] - fr_pk["minX"]) <= 0.5
                        and abs(fr_qk["minY"] - fr_pk["minY"]) <= 0.5
                        and abs(fr_qk["maxX"] - fr_pk["maxX"]) <= 0.5
                        and abs(fr_qk["maxY"] - fr_pk["maxY"]) <= 0.5
                    )
                    same_norm_margins = (
                        orig_frame_margins[qk] is not None
                        and orig_frame_margins[pk] is not None
                        and _same_norm_margins(orig_frame_margins[qk], orig_frame_margins[pk], tol=0.5)
                    )
                    valid_margin_fr_qk = (
                        margin_exp is not None
                        and abs(fr_qk["widthMm"] - (get_page_dims_mm(qk)[0] - 2.0 * float(margin_exp))) <= 2.0
                        and abs(fr_qk["heightMm"] - (get_page_dims_mm(qk)[1] - 2.0 * float(margin_exp))) <= 2.0
                    )
                    if same_frame_pos or same_norm_margins or valid_margin_fr_qk:
                        blocked = True
                        break
                if blocked:
                    clearing_set.remove(pk)
                    changed = True
        for pk in checked_keys:
            if pk not in clearing_set:
                continue
            pw_pk, ph_pk = get_page_dims_mm(pk)
            info_by_page[pk]["frame"] = None
            pieces_by_page[pk] = piece_candidates_for_page(page_shapes_by_num[pk], pw_pk, ph_pk, None)
        if clearing_set:
            _solids_by_page_cache.clear()
            _enclosing_sols_cache.clear()
            _dashed_cross_cache.clear()
            _aux_shapes_cache.clear()
            _aux_bleed_cache.clear()
            _ortho_step_cache.clear()

    # Internal lines: exclude calib squares, corner reg marks, outer tile border, unstroked page backgrounds, ALL closed shapes (e.g. dashed seam loops), and <=15mm notches/arrowheads
    internal_candidates: List[Dict[str, Any]] = []
    has_real_internal_lines = False
    promoted_optA_frame_p1 = False
    for p in checked_keys:
        pshapes = page_shapes_by_num[p]
        pw_p, ph_p = get_page_dims_mm(p)
        info_p = info_by_page[p]
        page_frame = info_p["frame"]
        page_internal: List[Dict[str, Any]] = []
        piece_polys: List[Dict[str, Any]] = []
        for s in pshapes:
            if is_square_of_size(s, calib_size, calib_tol) or is_square_of_size(s, 50.8, calib_tol):
                continue
            if is_unstroked_page_bg(s, pw_p, ph_p):
                continue
            if page_frame is not None and s is page_frame:
                continue
            if is_corner_reg_mark(s, pw_p, ph_p, calib_size, calib_tol, pshapes=pshapes):
                continue
            if s["closed"]:
                if s["widthMm"] >= 9.95 or s["heightMm"] >= 9.95:
                    piece_polys.append(s)
                continue
            if s["perimeterMm"] <= 15.0:
                continue
            page_internal.append(s)
        non_frame_solid_polys = [q for q in piece_polys if not q.get("dashed")]
        frame_repeated = False
        if page_frame is not None and page_count > 1:
            for qk in checked_keys:
                if qk == p:
                    continue
                fr_q = info_by_page[qk]["frame"]
                if fr_q is not None and (
                    abs(fr_q["minX"] - page_frame["minX"]) <= 0.5
                    and abs(fr_q["minY"] - page_frame["minY"]) <= 0.5
                    and abs(fr_q["maxX"] - page_frame["maxX"]) <= 0.5
                    and abs(fr_q["maxY"] - page_frame["maxY"]) <= 0.5
                ):
                    frame_repeated = True
                    break
        frame_encloses_or_overlaps_solid = False
        if page_frame is not None:
            for sp in non_frame_solid_polys:
                ov_x = min(sp["maxX"], page_frame["maxX"]) - max(sp["minX"], page_frame["minX"])
                ov_y = min(sp["maxY"], page_frame["maxY"]) - max(sp["minY"], page_frame["minY"])
                if ov_x > 1.0 and ov_y > 1.0:
                    frame_encloses_or_overlaps_solid = True
                    break
            if not frame_encloses_or_overlaps_solid:
                at_corner_reg_count = 0
                non_corner_regs: List[Dict[str, Any]] = []
                for sp in pshapes:
                    if sp is page_frame:
                        continue
                    if is_square_of_size(sp, calib_size, calib_tol) or is_square_of_size(sp, 50.8, calib_tol):
                        continue
                    if (pw_p < 84.0 or ph_p < 84.0) and (
                        is_square_of_size(sp, 20.0, calib_tol) or is_square_of_size(sp, 10.0, calib_tol)
                    ):
                        continue
                    if is_unstroked_page_bg(sp, pw_p, ph_p):
                        continue
                    if sp["widthMm"] < 1.5 and sp["heightMm"] < 1.5:
                        continue
                    if is_corner_reg_mark(sp, pw_p, ph_p, calib_size, calib_tol, pshapes=pshapes):
                        sp_cx = 0.5 * (sp["minX"] + sp["maxX"])
                        sp_cy = 0.5 * (sp["minY"] + sp["maxY"])
                        at_frame_corner = (
                            (abs(sp_cx - page_frame["minX"]) <= 1.5 or abs(sp_cx - page_frame["maxX"]) <= 1.5)
                            and (abs(sp_cy - page_frame["minY"]) <= 1.5 or abs(sp_cy - page_frame["maxY"]) <= 1.5)
                        )
                        if at_frame_corner:
                            at_corner_reg_count += 1
                            continue
                        ov_x = min(sp["maxX"], page_frame["maxX"]) - max(sp["minX"], page_frame["minX"])
                        ov_y = min(sp["maxY"], page_frame["maxY"]) - max(sp["minY"], page_frame["minY"])
                        if ov_x > 1.0 and ov_y > 1.0:
                            frame_encloses_or_overlaps_solid = True
                            break
                        non_corner_regs.append(sp)
                        continue
                    if not sp.get("closed"):
                        continue
                    if sp.get("dashed"):
                        if sp["widthMm"] >= 9.95 or sp["heightMm"] >= 9.95:
                            ov_x_d = min(sp["maxX"], page_frame["maxX"]) - max(sp["minX"], page_frame["minX"])
                            ov_y_d = min(sp["maxY"], page_frame["maxY"]) - max(sp["minY"], page_frame["minY"])
                            if ov_x_d > 1.0 and ov_y_d > 1.0:
                                continue
                        frame_encloses_or_overlaps_solid = True
                        break
                    # Any non-calib, non-reg-mark closed solid shape >= 1.5 mm (inside OR outside page_frame) blocks Option A
                    frame_encloses_or_overlaps_solid = True
                    break
                if not frame_encloses_or_overlaps_solid:
                    if at_corner_reg_count >= 1:
                        frame_encloses_or_overlaps_solid = True
                    elif non_corner_regs:
                        nc_cxs = [0.5 * (r["minX"] + r["maxX"]) for r in non_corner_regs]
                        nc_cys = [0.5 * (r["minY"] + r["maxY"]) for r in non_corner_regs]
                        distinct_corners: List[Tuple[float, float]] = []
                        for cx, cy in zip(nc_cxs, nc_cys):
                            if not any(math.hypot(cx - ux, cy - uy) <= 10.0 for ux, uy in distinct_corners):
                                distinct_corners.append((cx, cy))
                        if len(distinct_corners) < 4:
                            frame_encloses_or_overlaps_solid = True
                        else:
                            min_cx, max_cx = min(nc_cxs), max(nc_cxs)
                            min_cy, max_cy = min(nc_cys), max(nc_cys)
                            if not (
                                (max_cx - min_cx) > 10.0
                                and (max_cy - min_cy) > 10.0
                                and all(
                                    (abs(cx - min_cx) <= 1.5 or abs(cx - max_cx) <= 1.5)
                                    and (abs(cy - min_cy) <= 1.5 or abs(cy - max_cy) <= 1.5)
                                    for cx, cy in zip(nc_cxs, nc_cys)
                                )
                            ):
                                frame_encloses_or_overlaps_solid = True
        if (
            page_frame is not None
            and margin_exp is None
            and page_count == 1
        ):
            if (
                not frame_repeated
                and not frame_encloses_or_overlaps_solid
                and not non_frame_solid_polys
            ):
                piece_polys.append(page_frame)
                if p == 1:
                    promoted_optA_frame_p1 = True

        internal_candidates.extend(page_internal)

        def _in_or_on_poly(
            px: float,
            py: float,
            poly_pts: List[Tuple[float, float]],
            edge_tol: float = 0.05,
        ) -> Tuple[bool, float]:
            n_poly = len(poly_pts)
            min_d = float("inf")
            for idx_e in range(n_poly):
                a = poly_pts[idx_e]
                b = poly_pts[(idx_e + 1) % n_poly]
                d = point_to_segment_dist(px, py, a[0], a[1], b[0], b[1])
                if d < min_d:
                    min_d = d
            inside = point_in_polygon(px, py, poly_pts) or (min_d <= edge_tol)
            return inside, min_d

        def _ic_inside_poly(
            ic_pts: List[Tuple[float, float]],
            poly_pts: List[Tuple[float, float]],
        ) -> bool:
            if len(ic_pts) < 2 or len(poly_pts) < 3:
                return False

            poly_xs = [p[0] for p in poly_pts]
            poly_ys = [p[1] for p in poly_pts]
            p_min_x, p_max_x = min(poly_xs) - 0.05, max(poly_xs) + 0.05
            p_min_y, p_max_y = min(poly_ys) - 0.05, max(poly_ys) + 0.05
            for px, py in ic_pts:
                if px < p_min_x or px > p_max_x or py < p_min_y or py > p_max_y:
                    return False

            for px, py in ic_pts:
                pt_in, _ = _in_or_on_poly(px, py, poly_pts, edge_tol=0.05)
                if not pt_in:
                    return False

            n_poly = len(poly_pts)
            poly_edges = []
            for idx_e in range(n_poly):
                a = poly_pts[idx_e]
                b = poly_pts[(idx_e + 1) % n_poly]
                poly_edges.append((
                    a,
                    b,
                    min(a[0], b[0]) - 0.05,
                    max(a[0], b[0]) + 0.05,
                    min(a[1], b[1]) - 0.05,
                    max(a[1], b[1]) + 0.05,
                ))

            total_len = 0.0
            in_len = 0.0
            boundary_len = 0.0
            for k in range(len(ic_pts) - 1):
                x0, y0 = ic_pts[k]
                x1, y1 = ic_pts[k + 1]
                dx = x1 - x0
                dy = y1 - y0
                seg_len = math.hypot(dx, dy)
                if seg_len <= 1e-6:
                    continue
                total_len += seg_len

                s_min_x = min(x0, x1) - 0.05
                s_max_x = max(x0, x1) + 0.05
                s_min_y = min(y0, y1) - 0.05
                s_max_y = max(y0, y1) + 0.05
                t_hits: List[float] = []
                seg_len_sq = dx * dx + dy * dy
                for a, b, emin_x, emax_x, emin_y, emax_y in poly_edges:
                    if emax_x < s_min_x or emin_x > s_max_x or emax_y < s_min_y or emin_y > s_max_y:
                        continue
                    ex = b[0] - a[0]
                    ey = b[1] - a[1]
                    edge_len = math.hypot(ex, ey)
                    if edge_len <= 1e-9:
                        continue
                    denom = dx * ey - dy * ex
                    if abs(denom) > 1e-9 * max(1.0, seg_len * edge_len):
                        rx = a[0] - x0
                        ry = a[1] - y0
                        t = (rx * ey - ry * ex) / denom
                        u = (rx * dy - ry * dx) / denom
                        if -1e-6 <= u <= 1.0 + 1e-6 and 1e-6 < t < 1.0 - 1e-6:
                            t_hits.append(t)
                    else:
                        if point_to_segment_dist(a[0], a[1], x0, y0, x1, y1) <= 0.05:
                            ta = ((a[0] - x0) * dx + (a[1] - y0) * dy) / seg_len_sq
                            if 1e-6 < ta < 1.0 - 1e-6:
                                t_hits.append(ta)
                        if point_to_segment_dist(b[0], b[1], x0, y0, x1, y1) <= 0.05:
                            tb = ((b[0] - x0) * dx + (b[1] - y0) * dy) / seg_len_sq
                            if 1e-6 < tb < 1.0 - 1e-6:
                                t_hits.append(tb)

                t_hits.sort()
                ts_split = [0.0]
                for th in t_hits:
                    if th - ts_split[-1] > 1e-6 and 1.0 - th > 1e-6:
                        ts_split.append(th)
                ts_split.append(1.0)
                for idx_sub in range(len(ts_split) - 1):
                    t_mid = 0.5 * (ts_split[idx_sub] + ts_split[idx_sub + 1])
                    mx = x0 + t_mid * dx
                    my = y0 + t_mid * dy
                    mid_in, _ = _in_or_on_poly(mx, my, poly_pts, edge_tol=0.05)
                    if not mid_in:
                        return False

                mid_in_05, _ = _in_or_on_poly(0.5 * (x0 + x1), 0.5 * (y0 + y1), poly_pts, edge_tol=0.05)
                if not mid_in_05:
                    return False

                ts = (0.05, 0.25, 0.5, 0.75, 0.95)
                seg_in_hits = 0
                seg_bnd_hits = 0
                for t in ts:
                    sx = x0 + t * dx
                    sy = y0 + t * dy
                    s_in, s_min_d = _in_or_on_poly(sx, sy, poly_pts, edge_tol=0.05)
                    if s_in:
                        seg_in_hits += 1
                    if s_min_d <= 0.02 or not point_in_polygon(sx, sy, poly_pts):
                        seg_bnd_hits += 1
                in_len += seg_len * (seg_in_hits / len(ts))
                boundary_len += seg_len * (seg_bnd_hits / len(ts))

            if total_len <= 1e-6:
                return False
            if boundary_len > 0.80 * total_len:
                return False
            return in_len >= 0.98 * total_len

        if piece_polys and any(
            s["vertexCount"] >= 3 and any(_ic_inside_poly(s["points"], poly["points"]) for poly in piece_polys)
            for s in page_internal
        ):
            has_real_internal_lines = True
        if piece_polys and any(
            (not s["closed"]) and s["dashed"] and any(_ic_inside_poly(s["points"], poly["points"]) for poly in piece_polys)
            for s in page_internal
        ):
            has_real_internal_lines = True
        if not has_real_internal_lines and piece_polys and len(page_internal) >= 2:
            def _ic_owned_by_child(
                ic_pts: List[Tuple[float, float]],
                child_pts: List[Tuple[float, float]],
            ) -> bool:
                if len(ic_pts) == 2:
                    x0, y0 = ic_pts[0]
                    x1, y1 = ic_pts[1]
                    return all(
                        point_in_polygon(x0 + t * (x1 - x0), y0 + t * (y1 - y0), child_pts)
                        for t in (0.1, 0.5, 0.9)
                    )
                return all(
                    point_in_polygon(
                        0.5 * (ic_pts[k][0] + ic_pts[k + 1][0]),
                        0.5 * (ic_pts[k][1] + ic_pts[k + 1][1]),
                        child_pts,
                    )
                    for k in range(len(ic_pts) - 1)
                )

            solid_polys = [q for q in piece_polys if not q.get("dashed")]
            for poly in piece_polys:
                pts_poly = poly["points"]
                if page_frame is not None and poly is page_frame:
                    enclosed_children = [c for c in solid_polys if c is not poly]
                else:
                    enclosed_children = [
                        c for c in solid_polys
                        if c is not poly
                        and c["areaMm2"] < poly["areaMm2"] - 1.0
                        and c["minX"] >= poly["minX"] - 0.5
                        and c["maxX"] <= poly["maxX"] + 0.5
                        and c["minY"] >= poly["minY"] - 0.5
                        and c["maxY"] <= poly["maxY"] + 0.5
                    ]
                inside_count = 0
                for ic in page_internal:
                    ic_pts = ic["points"]
                    if len(ic_pts) < 2:
                        continue
                    inside = _ic_inside_poly(ic_pts, pts_poly)
                    if inside and not any(_ic_owned_by_child(ic_pts, ch["points"]) for ch in enclosed_children):
                        inside_count += 1
                        if inside_count >= 2:
                            has_real_internal_lines = True
                            break
                if has_real_internal_lines:
                    break

    if require_internal and (len(internal_candidates) == 0 or not has_real_internal_lines):
        errors.append(
            "Expected piece internalLines in PDF vectors (only single grainlines/seam loops/notches found)"
        )

    min_internal = expectations.get("minInternalLines", expectations.get("expectedInternalLines"))
    if min_internal is not None and len(internal_candidates) < int(min_internal):
        errors.append(
            f"Expected >= {int(min_internal)} open internalLines/grainlines in PDF vectors, got {len(internal_candidates)}"
        )

    # E08: Multi-Page PDF Tile Overlap Parity (<= 0.1 mm)
    tile_step_mm: Optional[float] = None
    measured_overlap_mm: Optional[float] = None
    tile_parity_max_err_mm: Optional[float] = None
    uf_parent: Dict[Tuple[int, int], Tuple[int, int]] = {}

    def uf_find(key: Tuple[int, int]) -> Tuple[int, int]:
        while uf_parent.get(key, key) != key:
            uf_parent[key] = uf_parent.get(uf_parent[key], uf_parent[key])
            key = uf_parent[key]
        return key

    def uf_union(a: Tuple[int, int], b: Tuple[int, int]) -> None:
        ra, rb = uf_find(a), uf_find(b)
        if ra != rb:
            if ra < rb:
                uf_parent[rb] = ra
            else:
                uf_parent[ra] = rb

    first_step_by_axis: Dict[str, Tuple[float, float]] = {}
    first_overlap_by_axis: Dict[str, float] = {}

    def _reg_mark_strictly_inside_solid(
        rm: Dict[str, Any],
        s: Dict[str, Any],
        clearance: float = 1.5,
    ) -> bool:
        cx = 0.5 * (rm["minX"] + rm["maxX"])
        cy = 0.5 * (rm["minY"] + rm["maxY"])
        if not (
            s["minX"] + clearance < cx < s["maxX"] - clearance
            and s["minY"] + clearance < cy < s["maxY"] - clearance
        ):
            return False
        s_pts = s.get("points") or []
        if len(s_pts) < 3 or not point_in_polygon(cx, cy, s_pts):
            return False
        n_pts = len(s_pts)
        for idx_p in range(n_pts):
            pa = s_pts[idx_p]
            pb = s_pts[(idx_p + 1) % n_pts]
            if point_to_segment_dist(cx, cy, pa[0], pa[1], pb[0], pb[1]) <= clearance:
                return False
        return True

    def _is_all_interior_drill_marks(
        info_obj: Dict[str, Any],
        pk_num: Optional[int],
    ) -> bool:
        if pk_num is None or not info_obj["regMarks"]:
            return False
        pw_pk, ph_pk = get_page_dims_mm(pk_num)
        rx_min = info_obj["regXMin"]
        rx_max = info_obj["regXMax"]
        ry_min = info_obj["regYMin"]
        ry_max = info_obj["regYMax"]
        has_opp_reg_x = (
            rx_min is not None
            and rx_max is not None
            and (rx_max - rx_min) > 10.0
            and rx_min <= min(50.0, 0.35 * pw_pk)
            and rx_max >= max(pw_pk - 50.0, 0.65 * pw_pk)
        )
        has_opp_reg_y = (
            ry_min is not None
            and ry_max is not None
            and (ry_max - ry_min) > 10.0
            and ry_min <= min(50.0, 0.35 * ph_pk)
            and ry_max >= max(ph_pk - 50.0, 0.65 * ph_pk)
        )
        solids_pk = [s for s in pieces_by_page.get(pk_num, []) if not s.get("dashed")]
        if not solids_pk:
            return False
        if has_opp_reg_x and has_opp_reg_y:
            all_enclosed = all(
                any(
                    _reg_mark_strictly_inside_solid(rm, s, clearance=1.5)
                    for s in solids_pk
                )
                for rm in info_obj["regMarks"]
            )
            if not all_enclosed:
                return False
            bbox_corners = [
                (rx_min, ry_min),
                (rx_max, ry_min),
                (rx_min, ry_max),
                (rx_max, ry_max),
            ]
            occupied_corners = [
                (bx_c, by_c)
                for bx_c, by_c in bbox_corners
                if any(
                    abs(0.5 * (rm["minX"] + rm["maxX"]) - bx_c) <= 1.5
                    and abs(0.5 * (rm["minY"] + rm["maxY"]) - by_c) <= 1.5
                    for rm in info_obj["regMarks"]
                )
            ]
            pw_pt_pk, ph_pt_pk = page_dims_pt.get(pk_num, (page_w_pt, page_h_pt))
            ctm_dx_pk = 0.5 * (pw_pt_pk - math.ceil(pw_pt_pk)) * pt_to_mm
            ctm_dy_pk = 0.5 * (ph_pt_pk - math.ceil(ph_pt_pk)) * pt_to_mm
            lm_d = rx_min - ctm_dx_pk
            rm_d = pw_pk - (rx_max - ctm_dx_pk)
            tm_d = ry_min - ctm_dy_pk
            bm_d = ph_pk - (ry_max - ctm_dy_pk)
            is_sym_page_corners = (
                -0.5 <= lm_d <= 35.0
                and -0.5 <= tm_d <= 35.0
                and abs(lm_d - rm_d) <= 1.5
                and abs(tm_d - bm_d) <= 1.5
                and abs(lm_d - tm_d) <= 1.5
            )
            fr_obj = info_obj["frame"]
            if fr_obj is not None:
                all_at_frame_corners = bool(occupied_corners) and all(
                    min(abs(cx_c - fr_obj["minX"]), abs(cx_c - fr_obj["maxX"])) <= 0.5
                    and min(abs(cy_c - fr_obj["minY"]), abs(cy_c - fr_obj["maxY"])) <= 0.5
                    for cx_c, cy_c in occupied_corners
                )
                if len(occupied_corners) >= 3 and (is_sym_page_corners or all_at_frame_corners):
                    return False
                return True
            if is_sym_page_corners:
                if len(occupied_corners) >= 3:
                    return False
                if len(occupied_corners) == 2:
                    sym_m_ref = 0.25 * (lm_d + rm_d + tm_d + bm_d)
                    other_has_regs = False
                    for qk in checked_keys:
                        if qk == pk_num or not info_by_page[qk]["regMarks"]:
                            continue
                        pw_qk, ph_qk = get_page_dims_mm(qk)
                        pw_qk_pt, ph_qk_pt = page_dims_pt.get(qk, (page_w_pt, page_h_pt))
                        ctm_dx_q = 0.5 * (pw_qk_pt - math.ceil(pw_qk_pt)) * pt_to_mm
                        ctm_dy_q = 0.5 * (ph_qk_pt - math.ceil(ph_qk_pt)) * pt_to_mm
                        solids_qk = _get_solids_for_page(qk)
                        q_distinct: List[Tuple[float, float]] = []
                        q_has_unenclosed = False
                        for r_q in info_by_page[qk]["regMarks"]:
                            qcx = 0.5 * (r_q["minX"] + r_q["maxX"]) - ctm_dx_q
                            qcy = 0.5 * (r_q["minY"] + r_q["maxY"]) - ctm_dy_q
                            if (
                                min(abs(qcx - sym_m_ref), abs(qcx - (pw_qk - sym_m_ref))) <= 0.5
                                and min(abs(qcy - sym_m_ref), abs(qcy - (ph_qk - sym_m_ref))) <= 0.5
                            ):
                                if not any(
                                    _reg_mark_strictly_inside_solid(r_q, s_q, clearance=1.5)
                                    for s_q in solids_qk
                                ):
                                    q_has_unenclosed = True
                                if not any(math.hypot(qcx - ux, qcy - uy) <= 10.0 for ux, uy in q_distinct):
                                    q_distinct.append((qcx, qcy))
                        if len(q_distinct) >= 2:
                            qx_span = max(p[0] for p in q_distinct) - min(p[0] for p in q_distinct)
                            qy_span = max(p[1] for p in q_distinct) - min(p[1] for p in q_distinct)
                            if (
                                (len(q_distinct) >= 3 and qx_span > 10.0 and qy_span > 10.0)
                                or (q_has_unenclosed and (qx_span > 10.0 or qy_span > 10.0))
                            ):
                                other_has_regs = True
                                break
                    matches_exp_margin = (
                        expectations.get("marginMm") is not None
                        and abs(lm_d - float(expectations["marginMm"])) <= 1.5 + FLOAT_CMP_EPS
                    )

                    def _has_valid_tiled_continuation(s_over: Dict[str, Any]) -> bool:
                        ov_l = s_over["minX"] < -1.0
                        ov_r = s_over["maxX"] > pw_pk + 1.0
                        ov_t = s_over["minY"] < -1.0
                        ov_b = s_over["maxY"] > ph_pk + 1.0
                        if not (ov_l or ov_r or ov_t or ov_b):
                            return True
                        if len(checked_keys) < 2:
                            return False
                        for qk in checked_keys:
                            if qk == pk_num:
                                continue
                            pw_qk, ph_qk = get_page_dims_mm(qk)
                            pw_qk_pt, ph_qk_pt = page_dims_pt.get(qk, (page_w_pt, page_h_pt))
                            ctm_dx_q = 0.5 * (pw_qk_pt - math.ceil(pw_qk_pt)) * pt_to_mm
                            ctm_dy_q = 0.5 * (ph_qk_pt - math.ceil(ph_qk_pt)) * pt_to_mm
                            ctm_dx_pq = ctm_dx_pk - ctm_dx_q
                            ctm_dy_pq = ctm_dy_pk - ctm_dy_q
                            for s2 in _get_solids_for_page(qk):
                                if (
                                    abs(s_over["widthMm"] - s2["widthMm"]) > 0.1 + FLOAT_CMP_EPS
                                    or abs(s_over["heightMm"] - s2["heightMm"]) > 0.1 + FLOAT_CMP_EPS
                                ):
                                    continue
                                area_tol_c = max(1.0, 0.01 * max(s_over["areaMm2"], s2["areaMm2"]))
                                if abs(s_over["areaMm2"] - s2["areaMm2"]) > area_tol_c:
                                    continue
                                dx_pq = (s_over["minX"] - s2["minX"]) - ctm_dx_pq
                                dy_pq = (s_over["minY"] - s2["minY"]) - ctm_dy_pq
                                x_ok = (ov_r and dx_pq > 10.0) or (ov_l and dx_pq < -10.0)
                                y_ok = (ov_b and dy_pq > 10.0) or (ov_t and dy_pq < -10.0)
                                is_x_cont = x_ok and abs(dy_pq) <= 0.1 + FLOAT_CMP_EPS
                                is_y_cont = y_ok and abs(dx_pq) <= 0.1 + FLOAT_CMP_EPS
                                if not (is_x_cont or is_y_cont):
                                    continue
                                if expected_overlap is not None:
                                    if is_x_cont:
                                        src_pk = pk_num if dx_pq > 0 else qk
                                        dim_src, _ = get_page_dims_mm(src_pk)
                                        fr_src = info_by_page[src_pk]["frame"]
                                        rmin_k, rmax_k, span_k = "regXMin", "regXMax", "widthMm"
                                        step_c = abs(dx_pq)
                                    else:
                                        src_pk = pk_num if dy_pq > 0 else qk
                                        _, dim_src = get_page_dims_mm(src_pk)
                                        fr_src = info_by_page[src_pk]["frame"]
                                        rmin_k, rmax_k, span_k = "regYMin", "regYMax", "heightMm"
                                        step_c = abs(dy_pq)
                                    if expectations.get("marginMm") is not None:
                                        span_c = dim_src - 2.0 * float(expectations["marginMm"])
                                    elif fr_src is not None:
                                        span_c = fr_src[span_k]
                                    else:
                                        span_c = dim_src
                                        if src_pk != pk_num:
                                            info_src = info_by_page[src_pk]
                                            rmin_s = info_src[rmin_k]
                                            rmax_s = info_src[rmax_k]
                                            if (
                                                rmin_s is not None
                                                and rmax_s is not None
                                                and (rmax_s - rmin_s) > 10.0
                                                and rmin_s <= min(50.0, 0.35 * dim_src)
                                                and rmax_s >= max(dim_src - 50.0, 0.65 * dim_src)
                                                and any(
                                                    not any(
                                                        _reg_mark_strictly_inside_solid(rm_s, s_s, clearance=1.5)
                                                        for s_s in _get_solids_for_page(src_pk)
                                                    )
                                                    for rm_s in info_src["regMarks"]
                                                )
                                            ):
                                                span_c = rmax_s - rmin_s
                                    if abs((span_c - step_c) - float(expected_overlap)) > 0.1 + FLOAT_CMP_EPS:
                                        continue
                                if (
                                    shifted_polygon_max_error(
                                        s_over["points"],
                                        s2["points"],
                                        s_over["minX"] - s2["minX"],
                                        s_over["minY"] - s2["minY"],
                                    )
                                    <= 0.1 + FLOAT_CMP_EPS
                                ):
                                    return True
                        return False

                    enclosing_overflows_page = any(
                        (
                            s["minX"] < -1.0
                            or s["maxX"] > pw_pk + 1.0
                            or s["minY"] < -1.0
                            or s["maxY"] > ph_pk + 1.0
                        )
                        and any(
                            _reg_mark_strictly_inside_solid(rm, s, clearance=1.5)
                            for rm in info_obj["regMarks"]
                        )
                        and not _has_valid_tiled_continuation(s)
                        for s in solids_pk
                    )
                    if other_has_regs or matches_exp_margin or enclosing_overflows_page:
                        return False
            return True
        if has_opp_reg_x or has_opp_reg_y:
            is_collinear = (
                ((ry_max - ry_min) <= 10.0 if (ry_min is not None and ry_max is not None) else True)
                if has_opp_reg_x
                else ((rx_max - rx_min) <= 10.0 if (rx_min is not None and rx_max is not None) else True)
            )
            if not is_collinear:
                return False
            return all(
                any(
                    _reg_mark_strictly_inside_solid(rm, s, clearance=1.5)
                    for s in solids_pk
                )
                for rm in info_obj["regMarks"]
            )
        return all(
            any(
                _reg_mark_strictly_inside_solid(rm, s, clearance=1.5)
                for s in solids_pk
            )
            for rm in info_obj["regMarks"]
        )

    def _select_outer_regs_for_margin_check(
        info_obj: Dict[str, Any],
        solids_list: List[Dict[str, Any]],
        pw_mm: float,
        ph_mm: float,
        ctm_dx_mm: float,
        ctm_dy_mm: float,
    ) -> List[Dict[str, Any]]:
        reg_marks = info_obj["regMarks"]
        outer_regs = [
            rm for rm in reg_marks
            if not any(_reg_mark_strictly_inside_solid(rm, s, clearance=1.5) for s in solids_list)
        ]
        if outer_regs:
            return outer_regs
        rx_min_o = info_obj["regXMin"]
        rx_max_o = info_obj["regXMax"]
        ry_min_o = info_obj["regYMin"]
        ry_max_o = info_obj["regYMax"]
        x_bounds: List[float] = []
        if rx_min_o is not None and (rx_min_o - ctm_dx_mm) <= min(50.0, 0.35 * pw_mm):
            x_bounds.append(rx_min_o)
        if (
            rx_max_o is not None
            and (rx_max_o - ctm_dx_mm) >= max(pw_mm - 50.0, 0.65 * pw_mm)
            and (not x_bounds or (rx_max_o - x_bounds[0]) > 10.0)
        ):
            x_bounds.append(rx_max_o)
        y_bounds: List[float] = []
        if ry_min_o is not None and (ry_min_o - ctm_dy_mm) <= min(50.0, 0.35 * ph_mm):
            y_bounds.append(ry_min_o)
        if (
            ry_max_o is not None
            and (ry_max_o - ctm_dy_mm) >= max(ph_mm - 50.0, 0.65 * ph_mm)
            and (not y_bounds or (ry_max_o - y_bounds[0]) > 10.0)
        ):
            y_bounds.append(ry_max_o)
        if x_bounds and y_bounds and (len(x_bounds) >= 2 or len(y_bounds) >= 2):
            corners_xy = [(cx, cy) for cx in x_bounds for cy in y_bounds]
            hull_regs = [
                rm_item for rm_item in reg_marks
                if any(
                    abs(0.5 * (rm_item["minX"] + rm_item["maxX"]) - c_pt[0]) <= 1.5
                    and abs(0.5 * (rm_item["minY"] + rm_item["maxY"]) - c_pt[1]) <= 1.5
                    for c_pt in corners_xy
                )
            ]
            if hull_regs:
                return hull_regs
        return reg_marks

    if expectations.get("marginMm") is not None:
        m_exp_val = float(expectations["marginMm"])
        for pk in checked_keys:
            info_pk = info_by_page[pk]
            pw_pk, ph_pk = get_page_dims_mm(pk)
            pw_pt_pk, ph_pt_pk = page_dims_pt.get(pk, (page_w_pt, page_h_pt))
            ctm_dx_pk = 0.5 * (pw_pt_pk - math.ceil(pw_pt_pk)) * pt_to_mm
            ctm_dy_pk = 0.5 * (ph_pt_pk - math.ceil(ph_pt_pk)) * pt_to_mm
            fr_pk = info_pk["frame"]
            if fr_pk is not None:
                lm_f = fr_pk["minX"] - ctm_dx_pk
                rm_f = pw_pk - (fr_pk["maxX"] - ctm_dx_pk)
                tm_f = fr_pk["minY"] - ctm_dy_pk
                bm_f = ph_pk - (fr_pk["maxY"] - ctm_dy_pk)
                max_frame_diff = max(
                    abs(lm_f - m_exp_val),
                    abs(rm_f - m_exp_val),
                    abs(tm_f - m_exp_val),
                    abs(bm_f - m_exp_val),
                )
                if max_frame_diff > 0.15 + FLOAT_CMP_EPS:
                    errors.append(
                        f"E08 Page {pk} tile border frame margins ({lm_f:.2f}, {tm_f:.2f}, {rm_f:.2f}, {bm_f:.2f})mm disagree with expected marginMm={m_exp_val:.2f} (off by {max_frame_diff:.2f}mm)"
                    )
            if not info_pk["regMarks"]:
                continue
            if _is_all_interior_drill_marks(info_pk, pk):
                continue
            solids_pk = _get_solids_for_page(pk)
            outer_regs = _select_outer_regs_for_margin_check(
                info_pk, solids_pk, pw_pk, ph_pk, ctm_dx_pk, ctm_dy_pk
            )
            for rm in outer_regs:
                rcx = 0.5 * (rm["minX"] + rm["maxX"]) - ctm_dx_pk
                rcy = 0.5 * (rm["minY"] + rm["maxY"]) - ctm_dy_pk
                dx_edge = min(abs(rcx - m_exp_val), abs(rcx - (pw_pk - m_exp_val)))
                dy_edge = min(abs(rcy - m_exp_val), abs(rcy - (ph_pk - m_exp_val)))
                if dx_edge > 0.15 + FLOAT_CMP_EPS or dy_edge > 0.15 + FLOAT_CMP_EPS:
                    errors.append(
                        f"E08 Page {pk} corner registration mark at ({rcx:.2f}, {rcy:.2f})mm disagrees with expected marginMm={m_exp_val:.2f} (off by {max(dx_edge, dy_edge):.2f}mm)"
                    )
                    break
    else:
        for pk in checked_keys:
            info_pk = info_by_page[pk]
            fr_pk = info_pk["frame"]
            if fr_pk is None or not info_pk["regMarks"]:
                continue
            if _is_all_interior_drill_marks(info_pk, pk):
                continue
            pw_pk, ph_pk = get_page_dims_mm(pk)
            pw_pt_pk, ph_pt_pk = page_dims_pt.get(pk, (page_w_pt, page_h_pt))
            ctm_dx_pk = 0.5 * (pw_pt_pk - math.ceil(pw_pt_pk)) * pt_to_mm
            ctm_dy_pk = 0.5 * (ph_pt_pk - math.ceil(ph_pt_pk)) * pt_to_mm
            lm_f = fr_pk["minX"] - ctm_dx_pk
            rm_f = pw_pk - (fr_pk["maxX"] - ctm_dx_pk)
            tm_f = fr_pk["minY"] - ctm_dy_pk
            bm_f = ph_pk - (fr_pk["maxY"] - ctm_dy_pk)
            solids_pk = _get_solids_for_page(pk)
            outer_regs = _select_outer_regs_for_margin_check(
                info_pk, solids_pk, pw_pk, ph_pk, ctm_dx_pk, ctm_dy_pk
            )
            for rm in outer_regs:
                rcx = 0.5 * (rm["minX"] + rm["maxX"]) - ctm_dx_pk
                rcy = 0.5 * (rm["minY"] + rm["maxY"]) - ctm_dy_pk
                dx_edge = min(abs(rcx - lm_f), abs(rcx - (pw_pk - rm_f)))
                dy_edge = min(abs(rcy - tm_f), abs(rcy - (ph_pk - bm_f)))
                if dx_edge > 0.15 + FLOAT_CMP_EPS or dy_edge > 0.15 + FLOAT_CMP_EPS:
                    errors.append(
                        f"E08 Page {pk} corner registration mark at ({rcx:.2f}, {rcy:.2f})mm disagrees with tile border frame margins ({lm_f:.2f}, {tm_f:.2f}, {rm_f:.2f}, {bm_f:.2f})mm (off by {max(dx_edge, dy_edge):.2f}mm)"
                    )
                    break

    if page_count > 1 and 1 in page_shapes_by_num and 2 in page_shapes_by_num:

        _prescan_steps_cache: Dict[Tuple[int, str], Tuple[List[Tuple[float, float]], List[Tuple[float, float]]]] = {}

        def _prescan_axis_steps(pk_num: int, axis: str) -> Tuple[List[Tuple[float, float]], List[Tuple[float, float]]]:
            ck = (pk_num, axis)
            if ck in _prescan_steps_cache:
                return _prescan_steps_cache[ck]
            solids_by_p: Dict[int, List[Dict[str, Any]]] = {
                pk: [s for s in pieces_by_page.get(pk, []) if not s.get("dashed")]
                for pk in checked_keys
            }

            def _is_grid_plausible_pair(pa: int, pb: int) -> bool:
                diff = pb - pa
                if diff <= 0:
                    return False
                if diff == 1:
                    return True
                return diff >= 2 and page_count >= 3 and (page_count % diff == 0)

            def _pair_has_ortho_page_cross(pa: int, pb: int, cur_axis: str) -> bool:
                pw_pa, ph_pa = get_page_dims_mm(pa)
                o_dim = ph_pa if cur_axis == "x" else pw_pa
                pw_pa_pt, ph_pa_pt = page_dims_pt.get(pa, (page_w_pt, page_h_pt))
                pw_pb_pt, ph_pb_pt = page_dims_pt.get(pb, (page_w_pt, page_h_pt))
                ctm_dx_o = 0.5 * ((pw_pa_pt - math.ceil(pw_pa_pt)) - (pw_pb_pt - math.ceil(pw_pb_pt))) * pt_to_mm
                ctm_dy_o = 0.5 * ((ph_pa_pt - math.ceil(ph_pa_pt)) - (ph_pb_pt - math.ceil(ph_pb_pt))) * pt_to_mm
                for s1 in solids_by_p.get(pa, []):
                    for s2 in solids_by_p.get(pb, []):
                        if abs(s1["widthMm"] - s2["widthMm"]) > 0.1 + FLOAT_CMP_EPS or abs(s1["heightMm"] - s2["heightMm"]) > 0.1 + FLOAT_CMP_EPS:
                            continue
                        area_tol_o = max(1.0, 0.01 * max(s1["areaMm2"], s2["areaMm2"]))
                        if abs(s1["areaMm2"] - s2["areaMm2"]) > area_tol_o:
                            continue
                        dx_o = (s1["minX"] - s2["minX"]) - ctm_dx_o
                        dy_o = (s1["minY"] - s2["minY"]) - ctm_dy_o
                        st_o = dy_o if cur_axis == "x" else dx_o
                        res_o = dx_o if cur_axis == "x" else dy_o
                        if st_o <= 10.0 or abs(res_o) > 0.1 + FLOAT_CMP_EPS:
                            continue
                        o1_min = s1["minY"] if cur_axis == "x" else s1["minX"]
                        o1_max = s1["maxY"] if cur_axis == "x" else s1["maxX"]
                        o2_min = s2["minY"] if cur_axis == "x" else s2["minX"]
                        o2_max = s2["maxY"] if cur_axis == "x" else s2["maxX"]
                        o_cross = (
                            o1_max > o_dim + 1.0
                            and o1_min <= o_dim + 2.5
                            and o2_min < -1.0
                            and o2_max >= -1.0
                        )
                        if (
                            not o_cross
                            and expected_overlap is not None
                            and abs((o_dim - st_o) - float(expected_overlap)) <= 0.1 + FLOAT_CMP_EPS
                            and o1_min <= o_dim + 2.5
                        ):
                            ov_lim_o = float(expected_overlap) + 1.5
                            if (
                                (o2_min < -1.0 and o2_max >= -1.0 and o1_max >= o_dim - ov_lim_o and o2_max <= ov_lim_o)
                                or (o1_max > o_dim + 1.0 and o1_min >= o_dim - ov_lim_o and o2_min >= -1.0 and o2_min <= ov_lim_o)
                            ):
                                o_cross = True
                        if o_cross and shifted_polygon_max_error(s1["points"], s2["points"], s1["minX"] - s2["minX"], s1["minY"] - s2["minY"]) <= 0.1 + FLOAT_CMP_EPS:
                            return True
                return False

            def _scan_pairs(pair_list: List[Tuple[int, int]]) -> Tuple[List[Tuple[float, float]], List[Tuple[float, float]]]:
                page_found: List[Tuple[float, float]] = []
                reg_found: List[Tuple[float, float]] = []
                for pa, pb in pair_list:
                    pw_pa, ph_pa = get_page_dims_mm(pa)
                    page_dim_pa = pw_pa if axis == "x" else ph_pa
                    info_pa = info_by_page[pa]
                    r_min_pa = info_pa["regXMin"] if axis == "x" else info_pa["regYMin"]
                    r_max_pa = info_pa["regXMax"] if axis == "x" else info_pa["regYMax"]
                    pw_pa_pt, ph_pa_pt = page_dims_pt.get(pa, (page_w_pt, page_h_pt))
                    pw_pb_pt, ph_pb_pt = page_dims_pt.get(pb, (page_w_pt, page_h_pt))
                    ctm_dx = 0.5 * ((pw_pa_pt - math.ceil(pw_pa_pt)) - (pw_pb_pt - math.ceil(pw_pb_pt))) * pt_to_mm
                    ctm_dy = 0.5 * ((ph_pa_pt - math.ceil(ph_pa_pt)) - (ph_pb_pt - math.ceil(ph_pb_pt))) * pt_to_mm
                    ortho_crossed: Optional[bool] = None
                    for s1 in solids_by_p.get(pa, []):
                        for s2 in solids_by_p.get(pb, []):
                            if abs(s1["widthMm"] - s2["widthMm"]) > 0.1 + FLOAT_CMP_EPS or abs(s1["heightMm"] - s2["heightMm"]) > 0.1 + FLOAT_CMP_EPS:
                                continue
                            area_tol = max(1.0, 0.01 * max(s1["areaMm2"], s2["areaMm2"]))
                            if abs(s1["areaMm2"] - s2["areaMm2"]) > area_tol:
                                continue
                            dx = (s1["minX"] - s2["minX"]) - ctm_dx
                            dy = (s1["minY"] - s2["minY"]) - ctm_dy
                            st = dx if axis == "x" else dy
                            res = dy if axis == "x" else dx
                            if st <= 10.0 or abs(res) > 0.1 + FLOAT_CMP_EPS:
                                continue
                            s1_min = s1["minX"] if axis == "x" else s1["minY"]
                            s1_max = s1["maxX"] if axis == "x" else s1["maxY"]
                            s2_min = s2["minX"] if axis == "x" else s2["minY"]
                            s2_max = s2["maxX"] if axis == "x" else s2["maxY"]
                            page_cross = (
                                s1_max > page_dim_pa + 1.0
                                and s1_min <= page_dim_pa + 2.5
                                and s2_min < -1.0
                                and s2_max >= -1.0
                            )
                            if (
                                not page_cross
                                and expected_overlap is not None
                                and abs((page_dim_pa - st) - float(expected_overlap)) <= 0.1 + FLOAT_CMP_EPS
                                and s1_min <= page_dim_pa + 2.5
                            ):
                                ov_lim = float(expected_overlap) + 1.5
                                if (
                                    (s2_min < -1.0 and s2_max >= -1.0 and s1_max >= page_dim_pa - ov_lim and s2_max <= ov_lim)
                                    or (s1_max > page_dim_pa + 1.0 and s1_min >= page_dim_pa - ov_lim and s2_min >= -1.0 and s2_min <= ov_lim)
                                ):
                                    page_cross = True
                            reg_cross = (
                                r_max_pa is not None
                                and r_min_pa is not None
                                and s1_max > r_max_pa + 1.0
                                and s1_min <= r_max_pa + 2.5
                                and s2_min < r_min_pa - 1.0
                                and s2_max >= r_min_pa - 1.0
                            )
                            if reg_cross and not page_cross:
                                if ortho_crossed is None:
                                    ortho_crossed = _pair_has_ortho_page_cross(pa, pb, axis)
                                if ortho_crossed:
                                    reg_cross = False
                            if not (page_cross or reg_cross):
                                continue
                            if shifted_polygon_max_error(s1["points"], s2["points"], s1["minX"] - s2["minX"], s1["minY"] - s2["minY"]) <= 0.1 + FLOAT_CMP_EPS:
                                if page_cross:
                                    page_found.append((st, page_dim_pa))
                                if reg_cross and r_max_pa is not None and r_min_pa is not None:
                                    reg_found.append((st, r_max_pa - r_min_pa))
                return page_found, reg_found

            inc_pairs = [
                (checked_keys[i], checked_keys[j])
                for i in range(len(checked_keys))
                for j in range(i + 1, len(checked_keys))
                if (checked_keys[i] == pk_num or checked_keys[j] == pk_num)
                and _is_grid_plausible_pair(checked_keys[i], checked_keys[j])
            ]
            page_steps_out, reg_steps_out = _scan_pairs(inc_pairs)
            if not page_steps_out:
                all_pairs = [
                    (checked_keys[i], checked_keys[j])
                    for i in range(len(checked_keys))
                    for j in range(i + 1, len(checked_keys))
                    if _is_grid_plausible_pair(checked_keys[i], checked_keys[j])
                ]
                all_page_steps, all_reg_steps = _scan_pairs(all_pairs)
                if all_page_steps:
                    page_steps_out = all_page_steps
                if not reg_steps_out and all_reg_steps:
                    reg_steps_out = all_reg_steps
            _prescan_steps_cache[ck] = (page_steps_out, reg_steps_out)
            return page_steps_out, reg_steps_out

        def _axis_uses_reg_span_for_drills(
            info_obj: Dict[str, Any],
            pk_num: Optional[int],
            axis: str,
        ) -> bool:
            if pk_num is None or info_obj["frame"] is not None or expectations.get("marginMm") is not None:
                return False
            if expected_overlap is None:
                return False
            if not _is_all_interior_drill_marks(info_obj, pk_num):
                return False
            pw_pk, ph_pk = get_page_dims_mm(pk_num)
            page_dim = pw_pk if axis == "x" else ph_pk
            r_min = info_obj["regXMin"] if axis == "x" else info_obj["regYMin"]
            r_max = info_obj["regXMax"] if axis == "x" else info_obj["regYMax"]
            has_opp = (
                r_min is not None
                and r_max is not None
                and (r_max - r_min) > 10.0
                and r_min <= min(50.0, 0.35 * page_dim)
                and r_max >= max(page_dim - 50.0, 0.65 * page_dim)
            )
            if not has_opp:
                return False
            page_steps_ax, reg_steps_ax = _prescan_axis_steps(pk_num, axis)
            if page_steps_ax and any(
                abs((src_page_dim - st_val) - float(expected_overlap)) <= 0.1 + FLOAT_CMP_EPS
                for st_val, src_page_dim in page_steps_ax
            ):
                return False
            if not reg_steps_ax:
                return False
            if any(info_by_page[qk]["frame"] is None and not info_by_page[qk]["regMarks"] for qk in checked_keys if qk != pk_num):
                return False
            pw_pt_pk, ph_pt_pk = page_dims_pt.get(pk_num, (page_w_pt, page_h_pt))
            ctm_pk = 0.5 * ((pw_pt_pk - math.ceil(pw_pt_pk)) if axis == "x" else (ph_pt_pk - math.ceil(ph_pt_pk))) * pt_to_mm
            ml_pk = r_min - ctm_pk
            mr_pk = page_dim - (r_max - ctm_pk)
            for qk in checked_keys:
                if qk == pk_num:
                    continue
                info_qk = info_by_page[qk]
                if info_qk["frame"] is None:
                    rq_min = info_qk["regXMin"] if axis == "x" else info_qk["regYMin"]
                    rq_max = info_qk["regXMax"] if axis == "x" else info_qk["regYMax"]
                    pw_qk, ph_qk = get_page_dims_mm(qk)
                    page_dim_qk = pw_qk if axis == "x" else ph_qk
                    if rq_min is None or rq_max is None or (rq_max - rq_min) <= 10.0:
                        return False
                    pw_pt_qk, ph_pt_qk = page_dims_pt.get(qk, (page_w_pt, page_h_pt))
                    ctm_qk = 0.5 * ((pw_pt_qk - math.ceil(pw_pt_qk)) if axis == "x" else (ph_pt_qk - math.ceil(ph_pt_qk))) * pt_to_mm
                    ml_qk = rq_min - ctm_qk
                    mr_qk = page_dim_qk - (rq_max - ctm_qk)
                    if abs(ml_qk - ml_pk) > 0.15 + FLOAT_CMP_EPS or abs(mr_qk - mr_pk) > 0.15 + FLOAT_CMP_EPS:
                        return False
            solids_pk_d = [s for s in pieces_by_page.get(pk_num, []) if not s.get("dashed")]
            for s_enc in solids_pk_d:
                if not any(_reg_mark_strictly_inside_solid(rm, s_enc, clearance=1.5) for rm in info_obj["regMarks"]):
                    continue
                s_min = s_enc["minX"] if axis == "x" else s_enc["minY"]
                s_max = s_enc["maxX"] if axis == "x" else s_enc["maxY"]
                if s_min >= -1.0 and s_max <= page_dim + 1.0 and (s_min < r_min - 1.0 or s_max > r_max + 1.0):
                    has_cont = False
                    for qk in checked_keys:
                        if qk == pk_num:
                            continue
                        pw_pt_qk, ph_pt_qk = page_dims_pt.get(qk, (page_w_pt, page_h_pt))
                        ctm_dx_pq = 0.5 * ((pw_pt_pk - math.ceil(pw_pt_pk)) - (pw_pt_qk - math.ceil(pw_pt_qk))) * pt_to_mm
                        ctm_dy_pq = 0.5 * ((ph_pt_pk - math.ceil(ph_pt_pk)) - (ph_pt_qk - math.ceil(ph_pt_qk))) * pt_to_mm
                        for s2_enc in pieces_by_page.get(qk, []):
                            if s2_enc.get("dashed"):
                                continue
                            if (
                                abs(s_enc["widthMm"] - s2_enc["widthMm"]) > 0.1 + FLOAT_CMP_EPS
                                or abs(s_enc["heightMm"] - s2_enc["heightMm"]) > 0.1 + FLOAT_CMP_EPS
                            ):
                                continue
                            area_tol_e = max(1.0, 0.01 * max(s_enc["areaMm2"], s2_enc["areaMm2"]))
                            if abs(s_enc["areaMm2"] - s2_enc["areaMm2"]) > area_tol_e:
                                continue
                            dx_pq = (s_enc["minX"] - s2_enc["minX"]) - ctm_dx_pq
                            dy_pq = (s_enc["minY"] - s2_enc["minY"]) - ctm_dy_pq
                            sh_ax = abs(dx_pq if axis == "x" else dy_pq)
                            res_ax = abs(dy_pq if axis == "x" else dx_pq)
                            if sh_ax <= 10.0 or res_ax > 0.1 + FLOAT_CMP_EPS:
                                continue
                            if shifted_polygon_max_error(
                                s_enc["points"],
                                s2_enc["points"],
                                s_enc["minX"] - s2_enc["minX"],
                                s_enc["minY"] - s2_enc["minY"],
                            ) <= 0.1 + FLOAT_CMP_EPS:
                                has_cont = True
                                break
                        if has_cont:
                            break
                    if not has_cont:
                        return False
            return any(abs((src_reg_span - st_val) - float(expected_overlap)) <= 0.1 + FLOAT_CMP_EPS for st_val, src_reg_span in reg_steps_ax)

        def _should_mirror_single_edge_reg(
            pk_self: Optional[int],
            axis: str,
            side: str,
            m_side: float,
        ) -> bool:
            default_mirror = (side == "lo")
            if pk_self is None or page_count < 2:
                return default_mirror

            # Signal 1: Same-axis peer-page corroboration (4/3/2-opp corners or opposite single-edge mark)
            opp_agree_sym = 0
            opp_agree_one_sided = 0
            for qk in checked_keys:
                if qk == pk_self:
                    continue
                inf_q = info_by_page.get(qk)
                if not inf_q or inf_q["frame"] is not None or not inf_q["regMarks"]:
                    continue
                if _is_all_interior_drill_marks(inf_q, qk):
                    continue
                pw_q, ph_q = get_page_dims_mm(qk)
                dim_q = pw_q if axis == "x" else ph_q
                pw_qt, ph_qt = page_dims_pt.get(qk, (page_w_pt, page_h_pt))
                ctm_q = 0.5 * ((pw_qt if axis == "x" else ph_qt) - math.ceil(pw_qt if axis == "x" else ph_qt)) * pt_to_mm
                rq_min = inf_q["regXMin"] if axis == "x" else inf_q["regYMin"]
                rq_max = inf_q["regXMax"] if axis == "x" else inf_q["regYMax"]
                if rq_min is None or rq_max is None:
                    continue
                q_has_opp = (
                    (rq_max - rq_min) > 10.0
                    and rq_min <= min(50.0, 0.35 * dim_q)
                    and rq_max >= max(dim_q - 50.0, 0.65 * dim_q)
                )
                if q_has_opp:
                    qm_lo = rq_min - ctm_q
                    qm_hi = dim_q - (rq_max - ctm_q)
                    if abs(qm_lo - m_side) <= 0.15 + FLOAT_CMP_EPS and abs(qm_hi - m_side) <= 0.15 + FLOAT_CMP_EPS:
                        opp_agree_sym += 1
                    elif (
                        (side == "hi" and abs(qm_lo) <= 0.15 + FLOAT_CMP_EPS and abs(qm_hi - m_side) <= 0.15 + FLOAT_CMP_EPS)
                        or (side == "lo" and abs(qm_hi) <= 0.15 + FLOAT_CMP_EPS and abs(qm_lo - m_side) <= 0.15 + FLOAT_CMP_EPS)
                    ):
                        opp_agree_one_sided += 1
                else:
                    q_lo_val = rq_min - ctm_q
                    q_has_lo = -0.15 <= q_lo_val <= 35.0
                    q_has_hi = rq_max >= max(dim_q - 50.0, 0.65 * dim_q)
                    q_hi_val = dim_q - (rq_max - ctm_q)
                    if side == "hi" and q_has_lo and not q_has_hi and abs(q_lo_val - m_side) <= 0.15 + FLOAT_CMP_EPS:
                        opp_agree_sym += 1
                    elif side == "lo" and q_has_hi and not q_has_lo and abs(q_hi_val - m_side) <= 0.15 + FLOAT_CMP_EPS:
                        opp_agree_sym += 1
            if opp_agree_sym > 0 and opp_agree_one_sided == 0:
                return True
            if opp_agree_one_sided > 0 and opp_agree_sym == 0:
                return False

            # Signal 2: Shifted crossing-solid step vs expected_overlap disambiguation
            if expected_overlap is None:
                return default_mirror

            def _page_axis_margins_hyp(p_idx: int, mirror_flag: bool) -> Tuple[float, float]:
                inf_p = info_by_page[p_idx]
                pw_p, ph_p = get_page_dims_mm(p_idx)
                dim_p = pw_p if axis == "x" else ph_p
                fr_p = inf_p["frame"]
                if fr_p is not None:
                    if axis == "x":
                        return fr_p["minX"], dim_p - fr_p["maxX"]
                    return fr_p["minY"], dim_p - fr_p["maxY"]
                if not inf_p["regMarks"] or _is_all_interior_drill_marks(inf_p, p_idx):
                    return 0.0, 0.0
                pw_pt_p, ph_pt_p = page_dims_pt.get(p_idx, (page_w_pt, page_h_pt))
                ctm_p = 0.5 * ((pw_pt_p if axis == "x" else ph_pt_p) - math.ceil(pw_pt_p if axis == "x" else ph_pt_p)) * pt_to_mm
                rp_min = inf_p["regXMin"] if axis == "x" else inf_p["regYMin"]
                rp_max = inf_p["regXMax"] if axis == "x" else inf_p["regYMax"]
                if rp_min is None or rp_max is None:
                    return 0.0, 0.0
                if (
                    (rp_max - rp_min) > 10.0
                    and rp_min <= min(50.0, 0.35 * dim_p)
                    and rp_max >= max(dim_p - 50.0, 0.65 * dim_p)
                ):
                    return max(0.0, rp_min - ctm_p), max(0.0, dim_p - (rp_max - ctm_p))
                tm_lo = rp_min - ctm_p
                p_has_lo = -0.15 <= tm_lo <= 35.0
                p_has_hi = rp_max >= max(dim_p - 50.0, 0.65 * dim_p)
                if p_has_lo and not p_has_hi:
                    v_lo = max(0.0, tm_lo)
                    return v_lo, (v_lo if (mirror_flag and v_lo > 0.05) else 0.0)
                if p_has_hi and not p_has_lo:
                    v_hi = max(0.0, dim_p - (rp_max - ctm_p))
                    return (v_hi if (mirror_flag and v_hi > 0.05) else 0.0), v_hi
                return 0.0, 0.0

            solids_by_p = {
                pk: [s for s in pieces_by_page.get(pk, []) if not s.get("dashed")]
                for pk in checked_keys
            }
            exp_ov_f = float(expected_overlap)
            best_pair_errs: Optional[Tuple[float, float, float]] = None

            def _scan_hyp_pairs(pairs_to_scan: List[Tuple[int, int]]) -> None:
                nonlocal best_pair_errs
                for pa, pb in pairs_to_scan:
                    diff = pb - pa
                    if diff <= 0:
                        continue
                    if diff >= 2 and not (page_count >= 3 and (page_count % diff == 0)):
                        continue
                    pw_pa, ph_pa = get_page_dims_mm(pa)
                    pw_pb, ph_pb = get_page_dims_mm(pb)
                    dim_pa = pw_pa if axis == "x" else ph_pa
                    dim_pb = pw_pb if axis == "x" else ph_pb
                    pw_pa_pt, ph_pa_pt = page_dims_pt.get(pa, (page_w_pt, page_h_pt))
                    pw_pb_pt, ph_pb_pt = page_dims_pt.get(pb, (page_w_pt, page_h_pt))
                    ctm_o_pa = 0.5 * ((pw_pa_pt if axis == "x" else ph_pa_pt) - math.ceil(pw_pa_pt if axis == "x" else ph_pa_pt)) * pt_to_mm
                    ctm_o_pb = 0.5 * ((pw_pb_pt if axis == "x" else ph_pb_pt) - math.ceil(pw_pb_pt if axis == "x" else ph_pb_pt)) * pt_to_mm
                    ctm_dx = 0.5 * ((pw_pa_pt - math.ceil(pw_pa_pt)) - (pw_pb_pt - math.ceil(pw_pb_pt))) * pt_to_mm
                    ctm_dy = 0.5 * ((ph_pa_pt - math.ceil(ph_pa_pt)) - (ph_pb_pt - math.ceil(ph_pb_pt))) * pt_to_mm
                    _, hi_pa_M = _page_axis_margins_hyp(pa, True)
                    lo_pb_M, _ = _page_axis_margins_hyp(pb, True)
                    _, hi_pa_Z = _page_axis_margins_hyp(pa, False)
                    lo_pb_Z, _ = _page_axis_margins_hyp(pb, False)
                    hi_bound_M = dim_pa - hi_pa_M
                    hi_bound_Z = dim_pa - hi_pa_Z
                    hi_thresh = min(hi_bound_M, hi_bound_Z) - max(0.0, exp_ov_f) - 1.5
                    lo_thresh = max(lo_pb_M, lo_pb_Z) + max(0.0, exp_ov_f) + 1.5
                    for s1 in solids_by_p.get(pa, []):
                        s1_min_u = (s1["minX"] if axis == "x" else s1["minY"]) - ctm_o_pa
                        s1_max_u = (s1["maxX"] if axis == "x" else s1["maxY"]) - ctm_o_pa
                        if s1_max_u < hi_thresh or s1_min_u > dim_pa + 2.5:
                            continue
                        for s2 in solids_by_p.get(pb, []):
                            if abs(s1["widthMm"] - s2["widthMm"]) > 0.1 + FLOAT_CMP_EPS or abs(s1["heightMm"] - s2["heightMm"]) > 0.1 + FLOAT_CMP_EPS:
                                continue
                            area_tol = max(1.0, 0.01 * max(s1["areaMm2"], s2["areaMm2"]))
                            if abs(s1["areaMm2"] - s2["areaMm2"]) > area_tol:
                                continue
                            dx = (s1["minX"] - s2["minX"]) - ctm_dx
                            dy = (s1["minY"] - s2["minY"]) - ctm_dy
                            st = dx if axis == "x" else dy
                            res = dy if axis == "x" else dx
                            if st <= 10.0 or abs(res) > 0.1 + FLOAT_CMP_EPS:
                                continue
                            s2_min_u = (s2["minX"] if axis == "x" else s2["minY"]) - ctm_o_pb
                            s2_max_u = (s2["maxX"] if axis == "x" else s2["maxY"]) - ctm_o_pb
                            if s2_min_u > lo_thresh or s2_min_u >= dim_pb - 1.0 or s2_max_u < -1.5:
                                continue
                            if shifted_polygon_max_error(s1["points"], s2["points"], s1["minX"] - s2["minX"], s1["minY"] - s2["minY"]) > 0.1 + FLOAT_CMP_EPS:
                                continue
                            imp_M = (hi_bound_M - lo_pb_M) - st
                            imp_Z = (hi_bound_Z - lo_pb_Z) - st
                            err_M = abs(imp_M - exp_ov_f)
                            err_Z = abs(imp_Z - exp_ov_f)
                            min_e = min(err_M, err_Z)
                            if min_e <= 5.0 and abs(err_M - err_Z) > 0.2:
                                if best_pair_errs is None or min_e < best_pair_errs[0]:
                                    best_pair_errs = (min_e, err_M, err_Z)

            inc_pairs = [
                (checked_keys[i], checked_keys[j])
                for i in range(len(checked_keys))
                for j in range(i + 1, len(checked_keys))
                if checked_keys[i] == pk_self or checked_keys[j] == pk_self
            ]
            _scan_hyp_pairs(inc_pairs)
            if best_pair_errs is None:
                all_pairs = [
                    (checked_keys[i], checked_keys[j])
                    for i in range(len(checked_keys))
                    for j in range(i + 1, len(checked_keys))
                ]
                _scan_hyp_pairs(all_pairs)
            if best_pair_errs is not None:
                return best_pair_errs[1] < best_pair_errs[2]
            return default_mirror

        def _compute_page_printable_box_with_shifts(
            info_obj: Dict[str, Any],
            pw_mm: float,
            ph_mm: float,
            pw_pt_val: float,
            ph_pt_val: float,
            pk_num: Optional[int] = None,
        ) -> Tuple[Tuple[float, float, float, float], Tuple[bool, bool, bool, bool]]:
            fr = info_obj["frame"]
            if fr is not None:
                return (fr["minX"], fr["minY"], fr["maxX"], fr["maxY"]), (True, True, True, True)
            if expectations.get("marginMm") is not None:
                m = float(expectations["marginMm"])
                return (m, m, pw_mm - m, ph_mm - m), (False, False, False, False)
            rx_min = info_obj["regXMin"]
            ry_min = info_obj["regYMin"]
            rx_max = info_obj["regXMax"]
            ry_max = info_obj["regYMax"]
            has_opp_reg_x = (
                rx_min is not None
                and rx_max is not None
                and (rx_max - rx_min) > 10.0
                and rx_min <= min(50.0, 0.35 * pw_mm)
                and rx_max >= max(pw_mm - 50.0, 0.65 * pw_mm)
            )
            has_opp_reg_y = (
                ry_min is not None
                and ry_max is not None
                and (ry_max - ry_min) > 10.0
                and ry_min <= min(50.0, 0.35 * ph_mm)
                and ry_max >= max(ph_mm - 50.0, 0.65 * ph_mm)
            )
            if rx_min is not None or ry_min is not None:
                if _is_all_interior_drill_marks(info_obj, pk_num):
                    use_rx = _axis_uses_reg_span_for_drills(info_obj, pk_num, "x")
                    use_ry = _axis_uses_reg_span_for_drills(info_obj, pk_num, "y")
                    sx0 = bool(use_rx and rx_min is not None)
                    sy0 = bool(use_ry and ry_min is not None)
                    sx1 = bool(use_rx and rx_max is not None)
                    sy1 = bool(use_ry and ry_max is not None)
                    return (
                        rx_min if sx0 else 0.0,
                        ry_min if sy0 else 0.0,
                        rx_max if sx1 else pw_mm,
                        ry_max if sy1 else ph_mm,
                    ), (sx0, sy0, sx1, sy1)
                ctm_dx = 0.5 * (pw_pt_val - math.ceil(pw_pt_val)) * pt_to_mm
                ctm_dy = 0.5 * (ph_pt_val - math.ceil(ph_pt_val)) * pt_to_mm
                if has_opp_reg_x:
                    mx, bx, sx0, sx1 = rx_min, rx_max, True, True
                else:
                    true_mx = (rx_min - ctm_dx) if rx_min is not None else None
                    has_left_mx = true_mx is not None and -0.15 <= true_mx <= 35.0
                    has_right_rx = rx_max is not None and rx_max >= max(pw_mm - 50.0, 0.65 * pw_mm)
                    if has_left_mx:
                        m_val_x = max(0.0, true_mx)
                        mx = rx_min if m_val_x > 0.05 else 0.0
                        sx0 = m_val_x > 0.05
                        if has_right_rx:
                            bx, sx1 = rx_max, True
                        elif m_val_x > 0.05 and _should_mirror_single_edge_reg(pk_num, "x", "lo", m_val_x):
                            bx, sx1 = pw_mm - m_val_x + ctm_dx, True
                        else:
                            bx, sx1 = pw_mm, False
                    elif has_right_rx:
                        m_val_rx = max(0.0, pw_mm - (rx_max - ctm_dx))
                        bx, sx1 = rx_max, True
                        if m_val_rx > 0.05 and m_val_rx <= 35.0 and _should_mirror_single_edge_reg(pk_num, "x", "hi", m_val_rx):
                            mx, sx0 = m_val_rx + ctm_dx, True
                        else:
                            mx, sx0 = 0.0, False
                    else:
                        mx, bx, sx0, sx1 = 0.0, pw_mm, False, False

                if has_opp_reg_y:
                    my, by, sy0, sy1 = ry_min, ry_max, True, True
                else:
                    true_my = (ry_min - ctm_dy) if ry_min is not None else None
                    has_top_my = true_my is not None and -0.15 <= true_my <= 35.0
                    has_bot_ry = ry_max is not None and ry_max >= max(ph_mm - 50.0, 0.65 * ph_mm)
                    if has_top_my:
                        m_val_y = max(0.0, true_my)
                        my = ry_min if m_val_y > 0.05 else 0.0
                        sy0 = m_val_y > 0.05
                        if has_bot_ry:
                            by, sy1 = ry_max, True
                        elif m_val_y > 0.05 and _should_mirror_single_edge_reg(pk_num, "y", "lo", m_val_y):
                            by, sy1 = ph_mm - m_val_y + ctm_dy, True
                        else:
                            by, sy1 = ph_mm, False
                    elif has_bot_ry:
                        m_val_ry = max(0.0, ph_mm - (ry_max - ctm_dy))
                        by, sy1 = ry_max, True
                        if m_val_ry > 0.05 and m_val_ry <= 35.0 and _should_mirror_single_edge_reg(pk_num, "y", "hi", m_val_ry):
                            my, sy0 = m_val_ry + ctm_dy, True
                        else:
                            my, sy0 = 0.0, False
                    else:
                        my, by, sy0, sy1 = 0.0, ph_mm, False, False

                return (mx, my, bx, by), (sx0, sy0, sx1, sy1)
            return (0.0, 0.0, pw_mm, ph_mm), (False, False, False, False)

        def compute_page_printable_box(
            info_obj: Dict[str, Any],
            pw_mm: float,
            ph_mm: float,
            pw_pt_val: float,
            ph_pt_val: float,
            pk_num: Optional[int] = None,
        ) -> Tuple[float, float, float, float]:
            return _compute_page_printable_box_with_shifts(
                info_obj, pw_mm, ph_mm, pw_pt_val, ph_pt_val, pk_num=pk_num
            )[0]

        def compute_page_overflow_box(
            info_obj: Dict[str, Any],
            pw_mm: float,
            ph_mm: float,
            pw_pt_val: float,
            ph_pt_val: float,
            box_pk: Tuple[float, float, float, float],
        ) -> Tuple[float, float, float, float]:
            fr = info_obj["frame"]
            if fr is not None:
                return fr["minX"], fr["minY"], fr["maxX"], fr["maxY"]
            if expectations.get("marginMm") is not None:
                m = float(expectations["marginMm"])
                return m, m, pw_mm - m, ph_mm - m
            rx_min = info_obj["regXMin"]
            ry_min = info_obj["regYMin"]
            rx_max = info_obj["regXMax"]
            ry_max = info_obj["regYMax"]
            has_opp_reg_x = (
                rx_min is not None
                and rx_max is not None
                and (rx_max - rx_min) > 10.0
                and rx_min <= min(50.0, 0.35 * pw_mm)
                and rx_max >= max(pw_mm - 50.0, 0.65 * pw_mm)
            )
            has_opp_reg_y = (
                ry_min is not None
                and ry_max is not None
                and (ry_max - ry_min) > 10.0
                and ry_min <= min(50.0, 0.35 * ph_mm)
                and ry_max >= max(ph_mm - 50.0, 0.65 * ph_mm)
            )
            if has_opp_reg_x and has_opp_reg_y:
                return box_pk
            if rx_min is not None or ry_min is not None:
                return box_pk
            return 0.0, 0.0, pw_mm, ph_mm

        def shape_overflows_box(
            s: Dict[str, Any],
            box: Tuple[Optional[float], Optional[float], Optional[float], Optional[float]],
            tol: float = 1.0,
        ) -> bool:
            if box[0] is None:
                return False
            return (
                s["minX"] < box[0] - tol
                or s["maxX"] > box[2] + tol
                or s["minY"] < box[1] - tol
                or s["maxY"] > box[3] + tol
            )

        box_by_page: Dict[int, Tuple[float, float, float, float]] = {}
        box_shift_flags_by_page: Dict[int, Tuple[bool, bool, bool, bool]] = {}
        overflow_box_by_page: Dict[int, Tuple[float, float, float, float]] = {}
        for pk in checked_keys:
            pw_pk, ph_pk = get_page_dims_mm(pk)
            pw_pt_pk, ph_pt_pk = page_dims_pt.get(pk, (page_w_pt, page_h_pt))
            box_pk, shift_flags_pk = _compute_page_printable_box_with_shifts(
                info_by_page[pk], pw_pk, ph_pk, pw_pt_pk, ph_pt_pk, pk_num=pk
            )
            box_by_page[pk] = box_pk
            box_shift_flags_by_page[pk] = shift_flags_pk
            overflow_box_by_page[pk] = compute_page_overflow_box(
                info_by_page[pk], pw_pk, ph_pk, pw_pt_pk, ph_pt_pk, box_by_page[pk]
            )
        unshifted_box_by_page: Dict[int, Tuple[Optional[float], Optional[float], Optional[float], Optional[float]]] = {}
        for pk in checked_keys:
            b_pk = box_by_page[pk]
            sf_pk = box_shift_flags_by_page.get(pk, (False, False, False, False))
            if b_pk[0] is not None and pk in page_dims_pt:
                pw_pt_pk, ph_pt_pk = page_dims_pt[pk]
                cdx_pk = 0.5 * (pw_pt_pk - math.ceil(pw_pt_pk)) * pt_to_mm
                cdy_pk = 0.5 * (ph_pt_pk - math.ceil(ph_pt_pk)) * pt_to_mm
                unshifted_box_by_page[pk] = (
                    (b_pk[0] - cdx_pk) if sf_pk[0] else b_pk[0],
                    (b_pk[1] - cdy_pk) if sf_pk[1] else b_pk[1],
                    (b_pk[2] - cdx_pk) if sf_pk[2] else b_pk[2],
                    (b_pk[3] - cdy_pk) if sf_pk[3] else b_pk[3],
                )
            else:
                unshifted_box_by_page[pk] = b_pk

        inherited_drill_pks: set = set()
        if (
            len(checked_keys) >= 2
            and expectations.get("marginMm") is None
            and all(info_by_page[pk]["frame"] is None for pk in checked_keys)
        ):
            empty_reg_pks = [pk for pk in checked_keys if not info_by_page[pk]["regMarks"]]
            drill_only_pks = [pk for pk in checked_keys if _is_all_interior_drill_marks(info_by_page[pk], pk)]
            reg_non_drill_pks = [
                pk for pk in checked_keys
                if info_by_page[pk]["regMarks"] and pk not in drill_only_pks
            ]
            if not empty_reg_pks and drill_only_pks and reg_non_drill_pks:
                ref_margins_list = []
                for qk in reg_non_drill_pks:
                    uq = unshifted_box_by_page[qk]
                    pw_q, ph_q = get_page_dims_mm(qk)
                    ref_margins_list.append((uq[0], pw_q - uq[2], uq[1], ph_q - uq[3]))
                margins_consistent = len(ref_margins_list) <= 1 or all(
                    max(abs(ref_margins_list[0][si] - m_tup[si]) for m_tup in ref_margins_list[1:]) <= 0.15 + FLOAT_CMP_EPS
                    for si in range(4)
                )
                if margins_consistent:
                    lm_ref, rm_ref, tm_ref, bm_ref = ref_margins_list[0]
                    solids_map_inh = {
                        pk: [s for s in pieces_by_page.get(pk, []) if not s.get("dashed")]
                        for pk in checked_keys
                    }
                    max_imp_ov = max(40.0, float(expected_overlap) + 1.0 if expected_overlap is not None else 40.0)
                    for pk in drill_only_pks:
                        pw_pk, ph_pk = get_page_dims_mm(pk)
                        sf_pk = box_shift_flags_by_page.get(pk, (False, False, False, False))
                        upk = unshifted_box_by_page[pk]
                        axis_ok = True
                        if (sf_pk[0] or sf_pk[2]) and (
                            abs(upk[0] - lm_ref) > 0.15 + FLOAT_CMP_EPS
                            or abs((pw_pk - upk[2]) - rm_ref) > 0.15 + FLOAT_CMP_EPS
                        ):
                            axis_ok = False
                        if (sf_pk[1] or sf_pk[3]) and (
                            abs(upk[1] - tm_ref) > 0.15 + FLOAT_CMP_EPS
                            or abs((ph_pk - upk[3]) - bm_ref) > 0.15 + FLOAT_CMP_EPS
                        ):
                            axis_ok = False
                        if not axis_ok:
                            continue
                        has_crossing_cont = False
                        for qk in checked_keys:
                            if qk == pk:
                                continue
                            pa, pb = (pk, qk) if pk < qk else (qk, pk)
                            diff_p = pb - pa
                            if diff_p <= 0:
                                continue
                            if diff_p >= 2 and not (page_count >= 3 and (page_count % diff_p == 0)):
                                continue
                            pw_pa, ph_pa = get_page_dims_mm(pa)
                            pw_pb, ph_pb = get_page_dims_mm(pb)
                            pw_pa_pt, ph_pa_pt = page_dims_pt.get(pa, (page_w_pt, page_h_pt))
                            pw_pb_pt, ph_pb_pt = page_dims_pt.get(pb, (page_w_pt, page_h_pt))
                            cdx_pa = 0.5 * (pw_pa_pt - math.ceil(pw_pa_pt)) * pt_to_mm
                            cdy_pa = 0.5 * (ph_pa_pt - math.ceil(ph_pa_pt)) * pt_to_mm
                            cdx_pb = 0.5 * (pw_pb_pt - math.ceil(pw_pb_pt)) * pt_to_mm
                            cdy_pb = 0.5 * (ph_pb_pt - math.ceil(ph_pb_pt)) * pt_to_mm
                            ctm_dx_p = cdx_pa - cdx_pb
                            ctm_dy_p = cdy_pa - cdy_pb
                            for s1 in solids_map_inh.get(pa, []):
                                for s2 in solids_map_inh.get(pb, []):
                                    if (
                                        abs(s1["widthMm"] - s2["widthMm"]) > 0.1 + FLOAT_CMP_EPS
                                        or abs(s1["heightMm"] - s2["heightMm"]) > 0.1 + FLOAT_CMP_EPS
                                    ):
                                        continue
                                    area_tol_p = max(1.0, 0.01 * max(s1["areaMm2"], s2["areaMm2"]))
                                    if abs(s1["areaMm2"] - s2["areaMm2"]) > area_tol_p:
                                        continue
                                    dx_p = (s1["minX"] - s2["minX"]) - ctm_dx_p
                                    dy_p = (s1["minY"] - s2["minY"]) - ctm_dy_p
                                    for ax_i in ("x", "y"):
                                        st_p = dx_p if ax_i == "x" else dy_p
                                        res_p = dy_p if ax_i == "x" else dx_p
                                        if st_p <= 10.0 or abs(res_p) > 0.1 + FLOAT_CMP_EPS:
                                            continue
                                        dim_pa = pw_pa if ax_i == "x" else ph_pa
                                        dim_pb = pw_pb if ax_i == "x" else ph_pb
                                        lo_m_i = lm_ref if ax_i == "x" else tm_ref
                                        hi_m_i = rm_ref if ax_i == "x" else bm_ref
                                        hi_pa = dim_pa - hi_m_i
                                        hi_pb = dim_pb - hi_m_i
                                        imp_ov = (hi_pa - lo_m_i) - st_p
                                        if not (-1.0 <= imp_ov <= max_imp_ov):
                                            continue
                                        ov_w = max(0.0, imp_ov)
                                        c_pa = cdx_pa if ax_i == "x" else cdy_pa
                                        c_pb = cdx_pb if ax_i == "x" else cdy_pb
                                        s1_min_u = (s1["minX"] if ax_i == "x" else s1["minY"]) - c_pa
                                        s1_max_u = (s1["maxX"] if ax_i == "x" else s1["maxY"]) - c_pa
                                        s2_min_u = (s2["minX"] if ax_i == "x" else s2["minY"]) - c_pb
                                        s2_max_u = (s2["maxX"] if ax_i == "x" else s2["maxY"]) - c_pb
                                        if not (
                                            s1_max_u > lo_m_i + 1.0
                                            and s1_min_u <= hi_pa + 2.5
                                            and s1_max_u >= hi_pa - ov_w - 1.5
                                            and s2_min_u < hi_pb - 1.0
                                            and s2_max_u >= lo_m_i - 1.5
                                            and s2_min_u <= lo_m_i + ov_w + 1.5
                                        ):
                                            continue
                                        if shifted_polygon_max_error(
                                            s1["points"], s2["points"], s1["minX"] - s2["minX"], s1["minY"] - s2["minY"]
                                        ) <= 0.1 + FLOAT_CMP_EPS:
                                            has_crossing_cont = True
                                            break
                                    if has_crossing_cont:
                                        break
                                if has_crossing_cont:
                                    break
                            if has_crossing_cont:
                                break
                        if has_crossing_cont:
                            inherited_drill_pks.add(pk)
                            ubox_new = (lm_ref, tm_ref, pw_pk - rm_ref, ph_pk - bm_ref)
                            unshifted_box_by_page[pk] = ubox_new
                            pw_pt_pk, ph_pt_pk = page_dims_pt.get(pk, (page_w_pt, page_h_pt))
                            cdx_pk = 0.5 * (pw_pt_pk - math.ceil(pw_pt_pk)) * pt_to_mm
                            cdy_pk = 0.5 * (ph_pt_pk - math.ceil(ph_pt_pk)) * pt_to_mm
                            box_new = (ubox_new[0] + cdx_pk, ubox_new[1] + cdy_pk, ubox_new[2] + cdx_pk, ubox_new[3] + cdy_pk)
                            box_by_page[pk] = box_new
                            box_shift_flags_by_page[pk] = (True, True, True, True)
                            overflow_box_by_page[pk] = box_new

        reported_box_inconsistency: set = set()
        margins_by_page: Dict[int, Tuple[float, float, float, float]] = {}
        if len(checked_keys) >= 2:
            ref_pk = checked_keys[0]
            box_ref = box_by_page[ref_pk]
            has_frame_ref = info_by_page[ref_pk]["frame"] is not None
            has_reg_non_drill_ref = (
                (bool(info_by_page[ref_pk]["regMarks"]) and not _is_all_interior_drill_marks(info_by_page[ref_pk], ref_pk))
                or (ref_pk in inherited_drill_pks)
            )
            for pk_chk in checked_keys[1:]:
                has_frame_chk = info_by_page[pk_chk]["frame"] is not None
                if has_frame_chk != has_frame_ref:
                    errors.append(
                        f"E08 inconsistent tile border frame presence between page {ref_pk} and page {pk_chk}"
                    )
                elif not has_frame_ref and not has_frame_chk:
                    has_reg_non_drill_chk = (
                        (bool(info_by_page[pk_chk]["regMarks"]) and not _is_all_interior_drill_marks(info_by_page[pk_chk], pk_chk))
                        or (pk_chk in inherited_drill_pks)
                    )
                    if has_reg_non_drill_chk != has_reg_non_drill_ref:
                        errors.append(
                            f"E08 inconsistent registration marks between page {ref_pk} and page {pk_chk}"
                        )

            orient_groups: List[List[int]] = []
            for pk in checked_keys:
                pw_pk, ph_pk = get_page_dims_mm(pk)
                placed = False
                for grp in orient_groups:
                    pw_g, ph_g = get_page_dims_mm(grp[0])
                    if abs(pw_pk - pw_g) <= 0.5 and abs(ph_pk - ph_g) <= 0.5:
                        grp.append(pk)
                        placed = True
                        break
                if not placed:
                    orient_groups.append([pk])

            for grp in orient_groups:
                valid_grp = [pk for pk in grp if unshifted_box_by_page[pk][0] is not None]
                if len(valid_grp) < 2:
                    continue
                g_ref = valid_grp[0]
                ubox_g_ref = unshifted_box_by_page[g_ref]
                for pk_chk in valid_grp[1:]:
                    ubox_chk = unshifted_box_by_page[pk_chk]
                    for ax_c, lo_i, hi_i in (("x", 0, 2), ("y", 1, 3)):
                        span_ref = ubox_g_ref[hi_i] - ubox_g_ref[lo_i]
                        span_chk = ubox_chk[hi_i] - ubox_chk[lo_i]
                        if (
                            abs(ubox_g_ref[lo_i] - ubox_chk[lo_i]) > 0.15 + FLOAT_CMP_EPS
                            or abs(ubox_g_ref[hi_i] - ubox_chk[hi_i]) > 0.15 + FLOAT_CMP_EPS
                            or abs(span_ref - span_chk) > 0.15 + FLOAT_CMP_EPS
                        ):
                            reported_box_inconsistency.add((g_ref, pk_chk, ax_c))
                            reported_box_inconsistency.add((pk_chk, g_ref, ax_c))
                            errors.append(
                                f"E08 inconsistent {ax_c}-axis printable box between page {g_ref} ([{ubox_g_ref[lo_i]:.2f}, {ubox_g_ref[hi_i]:.2f}]) and page {pk_chk} ([{ubox_chk[lo_i]:.2f}, {ubox_chk[hi_i]:.2f}])"
                            )
                for ax_c, lo_i, hi_i in (("x", 0, 2), ("y", 1, 3)):
                    p_lo_min = min(valid_grp, key=lambda p: unshifted_box_by_page[p][lo_i])
                    p_lo_max = max(valid_grp, key=lambda p: unshifted_box_by_page[p][lo_i])
                    p_hi_min = min(valid_grp, key=lambda p: unshifted_box_by_page[p][hi_i])
                    p_hi_max = max(valid_grp, key=lambda p: unshifted_box_by_page[p][hi_i])
                    p_sp_min = min(valid_grp, key=lambda p: unshifted_box_by_page[p][hi_i] - unshifted_box_by_page[p][lo_i])
                    p_sp_max = max(valid_grp, key=lambda p: unshifted_box_by_page[p][hi_i] - unshifted_box_by_page[p][lo_i])
                    checks_minmax = [
                        (p_lo_min, p_lo_max, unshifted_box_by_page[p_lo_max][lo_i] - unshifted_box_by_page[p_lo_min][lo_i]),
                        (p_hi_min, p_hi_max, unshifted_box_by_page[p_hi_max][hi_i] - unshifted_box_by_page[p_hi_min][hi_i]),
                        (
                            p_sp_min,
                            p_sp_max,
                            (unshifted_box_by_page[p_sp_max][hi_i] - unshifted_box_by_page[p_sp_max][lo_i])
                            - (unshifted_box_by_page[p_sp_min][hi_i] - unshifted_box_by_page[p_sp_min][lo_i]),
                        ),
                    ]
                    for pa_m, pb_m, diff_m in checks_minmax:
                        if diff_m > 0.15 + FLOAT_CMP_EPS and (pa_m, pb_m, ax_c) not in reported_box_inconsistency:
                            reported_box_inconsistency.add((pa_m, pb_m, ax_c))
                            reported_box_inconsistency.add((pb_m, pa_m, ax_c))
                            errors.append(
                                f"E08 inconsistent {ax_c}-axis printable box between page {pa_m} ([{unshifted_box_by_page[pa_m][lo_i]:.2f}, {unshifted_box_by_page[pa_m][hi_i]:.2f}]) and page {pb_m} ([{unshifted_box_by_page[pb_m][lo_i]:.2f}, {unshifted_box_by_page[pb_m][hi_i]:.2f}])"
                            )

            valid_margin_pks = [pk for pk in checked_keys if unshifted_box_by_page[pk][0] is not None]
            if len(valid_margin_pks) >= 2:
                for pk in valid_margin_pks:
                    ubx = unshifted_box_by_page.get(pk, box_by_page[pk])
                    pw_pk, ph_pk = get_page_dims_mm(pk)
                    margins_by_page[pk] = (ubx[0], pw_pk - ubx[2], ubx[1], ph_pk - ubx[3])

                for side_idx, side_name, ax_c in (
                    (0, "left", "x"),
                    (1, "right", "x"),
                    (2, "top", "y"),
                    (3, "bottom", "y"),
                ):
                    p_m_min = min(valid_margin_pks, key=lambda p: margins_by_page[p][side_idx])
                    p_m_max = max(valid_margin_pks, key=lambda p: margins_by_page[p][side_idx])
                    diff_m = margins_by_page[p_m_max][side_idx] - margins_by_page[p_m_min][side_idx]
                    if diff_m > 0.15 + FLOAT_CMP_EPS and (p_m_min, p_m_max, ax_c) not in reported_box_inconsistency:
                        reported_box_inconsistency.add((p_m_min, p_m_max, ax_c))
                        reported_box_inconsistency.add((p_m_max, p_m_min, ax_c))
                        errors.append(
                            f"E08 inconsistent {side_name} printable margin between page {p_m_min} ({margins_by_page[p_m_min][side_idx]:.2f}mm) and page {p_m_max} ({margins_by_page[p_m_max][side_idx]:.2f}mm)"
                        )

        page_has_margin_bleed: Dict[int, bool] = {
            pk: any(
                not s.get("dashed")
                and (
                    (box_by_page[pk][2] is not None and s["minX"] > box_by_page[pk][2] + 2.5 and s["maxX"] > box_by_page[pk][2] + 1.0)
                    or (box_by_page[pk][3] is not None and s["minY"] > box_by_page[pk][3] + 2.5 and s["maxY"] > box_by_page[pk][3] + 1.0)
                )
                for s in pieces_by_page[pk]
            )
            for pk in checked_keys
        }

        def is_facing_overflow_match(
            s1: Dict[str, Any],
            s2: Dict[str, Any],
            dx: float,
            dy: float,
            box_a: Tuple[Optional[float], Optional[float], Optional[float], Optional[float]],
            box_b: Tuple[Optional[float], Optional[float], Optional[float], Optional[float]],
            expected_axis: Optional[str] = None,
            dashed_cross_x: Optional[set] = None,
            dashed_cross_y: Optional[set] = None,
            pk_a: Optional[int] = None,
            grid_cfg: Any = None,
            ubox_a: Optional[Tuple[Optional[float], Optional[float], Optional[float], Optional[float]]] = None,
            ubox_b: Optional[Tuple[Optional[float], Optional[float], Optional[float], Optional[float]]] = None,
        ) -> bool:
            if box_a[0] is None or box_b[0] is None:
                return True
            ub_a = ubox_a if ubox_a is not None else box_a
            ub_b = ubox_b if ubox_b is not None else box_b
            ov_tol = max(40.0, float(expected_overlap) + 1.0) if expected_overlap is not None else 40.0
            ov_strip_limit = (float(expected_overlap) + 1.5) if expected_overlap is not None else ov_tol
            axis_is_x = (expected_axis == "x") if expected_axis in ("x", "y") else (dx >= dy)
            if axis_is_x:
                s1_cross_x = (s1["minX"] <= box_a[2] + 1.0 and s1["maxX"] > box_a[2] + 1.0) or (
                    dashed_cross_x is not None and id(s1) in dashed_cross_x
                )
                s1_bleed_x = (
                    not s1.get("dashed")
                    and s1["minX"] > box_a[2] + 1.0
                    and (
                        s1["minX"] <= box_a[2] + 2.5
                        or (pk_a is not None and _piece_has_aux_bleed(pk_a, s1, "x", "max", box_a[2], grid_cfg=grid_cfg))
                    )
                    and s1["maxX"] > box_a[2] + 1.0
                )
                if not (s1_cross_x or s1_bleed_x or (s2["maxX"] >= box_b[0] - 1.0 and s2["minX"] < box_b[0] - 1.0)):
                    return False
                implied_ov = (ub_a[2] - ub_b[0]) - dx
                if implied_ov < -1.0 or implied_ov > ov_tol:
                    return False
                if s1_bleed_x and not s1_cross_x and not (s2["maxX"] >= box_b[0] - 1.0 and s2["minX"] < box_b[0] - 1.0):
                    if implied_ov < -0.1 - FLOAT_CMP_EPS:
                        return False
                    if expected_overlap is not None and abs(implied_ov - float(expected_overlap)) > 0.1 + FLOAT_CMP_EPS:
                        return False
                if s1["minX"] < box_a[2] - ov_strip_limit and s1["maxX"] > box_a[2] + 1.0:
                    if s2["minX"] >= box_b[0] - 1.0:
                        return False
                if s2["minX"] < box_b[0] - 1.0 and s1["maxX"] <= box_a[2] + 1.0:
                    if s1["maxX"] < box_a[2] - ov_strip_limit or s2["maxX"] > box_b[0] + ov_strip_limit:
                        return False
                return True
            s1_cross_y = (s1["minY"] <= box_a[3] + 1.0 and s1["maxY"] > box_a[3] + 1.0) or (
                dashed_cross_y is not None and id(s1) in dashed_cross_y
            )
            s1_bleed_y = (
                not s1.get("dashed")
                and s1["minY"] > box_a[3] + 1.0
                and (
                    s1["minY"] <= box_a[3] + 2.5
                    or (pk_a is not None and _piece_has_aux_bleed(pk_a, s1, "y", "max", box_a[3], grid_cfg=grid_cfg))
                )
                and s1["maxY"] > box_a[3] + 1.0
            )
            if not (s1_cross_y or s1_bleed_y or (s2["maxY"] >= box_b[1] - 1.0 and s2["minY"] < box_b[1] - 1.0)):
                return False
            implied_ov = (ub_a[3] - ub_b[1]) - dy
            if implied_ov < -1.0 or implied_ov > ov_tol:
                return False
            if s1_bleed_y and not s1_cross_y and not (s2["maxY"] >= box_b[1] - 1.0 and s2["minY"] < box_b[1] - 1.0):
                if implied_ov < -0.1 - FLOAT_CMP_EPS:
                    return False
                if expected_overlap is not None and abs(implied_ov - float(expected_overlap)) > 0.1 + FLOAT_CMP_EPS:
                    return False
            if s1["minY"] < box_a[3] - ov_strip_limit and s1["maxY"] > box_a[3] + 1.0:
                if s2["minY"] >= box_b[1] - 1.0:
                    return False
            if s2["minY"] < box_b[1] - 1.0 and s1["maxY"] <= box_a[3] + 1.0:
                if s1["maxY"] < box_a[3] - ov_strip_limit or s2["maxY"] > box_b[1] + ov_strip_limit:
                    return False
            return True

        def is_true_wrap_candidate(
            s1: Dict[str, Any],
            s2: Dict[str, Any],
            dx: float,
            dy: float,
            box_a: Tuple[Optional[float], Optional[float], Optional[float], Optional[float]],
            box_b: Tuple[Optional[float], Optional[float], Optional[float], Optional[float]],
            pw_a: float,
            ph_a: float,
        ) -> bool:
            if box_a[0] is not None and not (shape_overflows_box(s1, box_a) or shape_overflows_box(s2, box_b)):
                return False
            if dx < -10.0 and dy > 10.0:
                return dy >= 0.4 * ph_a or (
                    box_a[1] is not None and box_b[1] is not None
                    and s1["minY"] >= box_a[1] - 1.0 and s2["minY"] < box_b[1] - 1.0
                )
            if dy < -10.0 and dx > 10.0:
                return dx >= 0.4 * pw_a or (
                    box_a[0] is not None and box_b[0] is not None
                    and s1["minX"] >= box_a[0] - 1.0 and s2["minX"] < box_b[0] - 1.0
                )
            return False

        def select_pair_matches(
            raw_matches: List[Tuple[int, int, Dict[str, Any], Dict[str, Any], float, float]],
            box_a: Tuple[Optional[float], Optional[float], Optional[float], Optional[float]],
            box_b: Tuple[Optional[float], Optional[float], Optional[float], Optional[float]],
            expected_axis: Optional[str] = None,
            ubox_a: Optional[Tuple[Optional[float], Optional[float], Optional[float], Optional[float]]] = None,
            ubox_b: Optional[Tuple[Optional[float], Optional[float], Optional[float], Optional[float]]] = None,
        ) -> List[Tuple[Dict[str, Any], Dict[str, Any], float, float]]:
            if len(raw_matches) <= 1:
                return [(s1, s2, dx, dy) for _, _, s1, s2, dx, dy in raw_matches]

            ub_a = ubox_a if ubox_a is not None else box_a
            ub_b = ubox_b if ubox_b is not None else box_b
            scored: List[Tuple[Tuple[int, int, int, int, int, float, float, float], int, int, Dict[str, Any], Dict[str, Any], float, float]] = []
            for i1, i2, s1, s2, dx, dy in raw_matches:
                is_ortho = min(abs(dx), abs(dy)) <= 0.1 + FLOAT_CMP_EPS
                axis_raw = "x" if dx >= dy else "y"
                axis_mismatch = 0 if (expected_axis is None or axis_raw == expected_axis) else 1
                check_axis = expected_axis if expected_axis in ("x", "y") else axis_raw
                poly_err = shifted_polygon_max_error(
                    s1["points"], s2["points"], s1["minX"] - s2["minX"], s1["minY"] - s2["minY"]
                )
                if box_a[0] is not None and box_b[0] is not None:
                    if check_axis == "x":
                        s1_crosses = s1["minX"] <= box_a[2] + 2.5 and s1["maxX"] > box_a[2] + 1.0
                        s2_crosses = s2["maxX"] >= box_b[0] - 1.0 and s2["minX"] < box_b[0] - 1.0
                        implied_ov = (ub_a[2] - ub_b[0]) - dx
                    else:
                        s1_crosses = s1["minY"] <= box_a[3] + 2.5 and s1["maxY"] > box_a[3] + 1.0
                        s2_crosses = s2["maxY"] >= box_b[1] - 1.0 and s2["minY"] < box_b[1] - 1.0
                        implied_ov = (ub_a[3] - ub_b[1]) - dy
                    both_cross_mismatch = 0 if (s1_crosses and s2_crosses) else 1
                    if expected_overlap is not None:
                        ov_err = abs(implied_ov - float(expected_overlap))
                        ov_mismatch = 0 if ov_err <= 0.1 + FLOAT_CMP_EPS else 1
                    else:
                        ov_err = 0.0
                        ov_mismatch = 0
                else:
                    both_cross_mismatch = 0
                    ov_err = 0.0
                    ov_mismatch = 0
                scored.append((
                    (
                        axis_mismatch,
                        ov_mismatch,
                        both_cross_mismatch,
                        0 if poly_err <= 0.1 + FLOAT_CMP_EPS else 1,
                        0 if is_ortho else 1,
                        ov_err,
                        min(abs(dx), abs(dy)),
                        poly_err,
                    ),
                    i1, i2, s1, s2, dx, dy,
                ))

            scored.sort(key=lambda item: item[0])

            selected: List[Tuple[Dict[str, Any], Dict[str, Any], float, float]] = []
            used_i1 = set()
            used_i2 = set()
            for _, i1, i2, s1, s2, dx, dy in scored:
                if i1 in used_i1 or i2 in used_i2:
                    continue
                used_i1.add(i1)
                used_i2.add(i2)
                selected.append((s1, s2, dx, dy))
            return selected

        def compute_pair_candidates_lists(
            p_a: int,
            p_b: int,
            expected_axis: Optional[str] = None,
            grid_cfg: Any = None,
        ) -> Tuple[
            List[Tuple[Dict[str, Any], Dict[str, Any], float, float]],
            List[Tuple[Dict[str, Any], Dict[str, Any], float, float]],
            List[Tuple[Dict[str, Any], Dict[str, Any], float, float]],
        ]:
            info_a = info_by_page[p_a]
            info_b = info_by_page[p_b]
            frame_a = info_a["frame"]
            pieces_a = pieces_by_page[p_a]
            pieces_b = pieces_by_page[p_b]
            box_a = box_by_page[p_a]
            box_b = box_by_page[p_b]
            ubox_a = unshifted_box_by_page[p_a]
            ubox_b = unshifted_box_by_page[p_b]
            pw_a, ph_a = get_page_dims_mm(p_a)
            pw_b, ph_b = get_page_dims_mm(p_b)

            poppler_ctm_dx = 0.0
            poppler_ctm_dy = 0.0
            if p_a in page_dims_pt and p_b in page_dims_pt:
                pw_a_pt, ph_a_pt = page_dims_pt[p_a]
                pw_b_pt, ph_b_pt = page_dims_pt[p_b]
                poppler_ctm_dx = 0.5 * ((pw_a_pt - math.ceil(pw_a_pt)) - (pw_b_pt - math.ceil(pw_b_pt))) * pt_to_mm
                poppler_ctm_dy = 0.5 * ((ph_a_pt - math.ceil(ph_a_pt)) - (ph_b_pt - math.ceil(ph_b_pt))) * pt_to_mm

            f_min_x = frame_a["minX"] if frame_a else 0.0
            f_max_x = frame_a["maxX"] if frame_a else pw_a
            f_min_y = frame_a["minY"] if frame_a else 0.0
            f_max_y = frame_a["maxY"] if frame_a else ph_a

            dashed_in_crossing_solid_x, dashed_in_crossing_solid_y = _get_dashed_in_crossing_solid(p_a, box_a, grid_cfg=grid_cfg)

            size_matched: List[Tuple[Dict[str, Any], Dict[str, Any], float, float]] = []
            raw_solid_matches: List[Tuple[int, int, Dict[str, Any], Dict[str, Any], float, float]] = []
            raw_dashed_matches: List[Tuple[int, int, Dict[str, Any], Dict[str, Any], float, float]] = []
            wrap_candidates: List[Tuple[Dict[str, Any], Dict[str, Any], float, float]] = []
            for i1, s1 in enumerate(pieces_a):
                for i2, s2 in enumerate(pieces_b):
                    if bool(s1.get("dashed")) != bool(s2.get("dashed")):
                        continue
                    if abs(s1["widthMm"] - s2["widthMm"]) > 0.1 + FLOAT_CMP_EPS or abs(s1["heightMm"] - s2["heightMm"]) > 0.1 + FLOAT_CMP_EPS:
                        continue
                    area_tol = max(1.0, 0.01 * max(s1["areaMm2"], s2["areaMm2"]))
                    if abs(s1["areaMm2"] - s2["areaMm2"]) > area_tol:
                        continue
                    dx = (s1["minX"] - s2["minX"]) - poppler_ctm_dx
                    dy = (s1["minY"] - s2["minY"]) - poppler_ctm_dy
                    size_matched.append((s1, s2, dx, dy))
                    if page_count >= 3 and p_b == p_a + 1:
                        if (dx < -10.0 and dy > 10.0) or (dy < -10.0 and dx > 10.0):
                            wrap_candidates.append((s1, s2, dx, dy))
                            continue
                    if expected_axis == "x":
                        if dx <= 10.0:
                            continue
                    elif expected_axis == "y":
                        if dy <= 10.0:
                            continue
                    elif dx <= 10.0 and dy <= 10.0:
                        continue
                    if not is_facing_overflow_match(
                        s1,
                        s2,
                        dx,
                        dy,
                        box_a,
                        box_b,
                        expected_axis=expected_axis,
                        dashed_cross_x=dashed_in_crossing_solid_x,
                        dashed_cross_y=dashed_in_crossing_solid_y,
                        pk_a=p_a,
                        grid_cfg=grid_cfg,
                        ubox_a=ubox_a,
                        ubox_b=ubox_b,
                    ):
                        continue
                    axis_is_x = (expected_axis == "x") if expected_axis in ("x", "y") else (dx >= dy)
                    if axis_is_x:
                        if s1["maxX"] < f_min_x + dx - 5.0 or s2["minX"] > f_max_x + 5.0:
                            continue
                    else:
                        if s1["maxY"] < f_min_y + dy - 5.0 or s2["minY"] > f_max_y + 5.0:
                            continue
                    if s1.get("dashed"):
                        raw_dashed_matches.append((i1, i2, s1, s2, dx, dy))
                    else:
                        raw_solid_matches.append((i1, i2, s1, s2, dx, dy))
            solid_matches = select_pair_matches(
                raw_solid_matches, box_a, box_b, expected_axis=expected_axis, ubox_a=ubox_a, ubox_b=ubox_b
            )
            solid_match_shifts_by_id = {id(m1): (mdx, mdy) for m1, _, mdx, mdy in solid_matches}
            filtered_dashed_matches: List[Tuple[int, int, Dict[str, Any], Dict[str, Any], float, float]] = []
            for i1, i2, s1, s2, dx, dy in raw_dashed_matches:
                is_margin_res = (
                    (box_a[2] is not None and s1["minX"] > box_a[2] + 1.0)
                    or (box_a[3] is not None and s1["minY"] > box_a[3] + 1.0)
                )
                enclosing_sols = _get_enclosing_sols(p_a, s1)
                if (
                    is_margin_res
                    or id(s1) in dashed_in_crossing_solid_x
                    or id(s1) in dashed_in_crossing_solid_y
                    or enclosing_sols
                ):
                    if not any(
                        id(sol) in solid_match_shifts_by_id
                        and abs(dx - solid_match_shifts_by_id[id(sol)][0]) <= 0.1 + FLOAT_CMP_EPS
                        and abs(dy - solid_match_shifts_by_id[id(sol)][1]) <= 0.1 + FLOAT_CMP_EPS
                        for sol in enclosing_sols
                    ):
                        continue
                filtered_dashed_matches.append((i1, i2, s1, s2, dx, dy))
            dashed_matches = select_pair_matches(
                filtered_dashed_matches, box_a, box_b, expected_axis=expected_axis, ubox_a=ubox_a, ubox_b=ubox_b
            )
            pair_matches = solid_matches + dashed_matches
            return size_matched, pair_matches, wrap_candidates

        # Memoize compute_pair_candidates_lists across grid scoring and final verification
        _pair_cands_cache: Dict[
            Tuple[int, int, Optional[str], Any],
            Tuple[
                List[Tuple[Dict[str, Any], Dict[str, Any], float, float]],
                List[Tuple[Dict[str, Any], Dict[str, Any], float, float]],
                List[Tuple[Dict[str, Any], Dict[str, Any], float, float]],
            ],
        ] = {}

        def get_pair_cands(p_a: int, p_b: int, expected_axis: Optional[str] = None, grid_cfg: Any = None):
            eff_grid_cfg = grid_cfg if page_has_margin_bleed.get(p_a, False) else None
            key = (p_a, p_b, expected_axis, eff_grid_cfg)
            if key not in _pair_cands_cache:
                _pair_cands_cache[key] = compute_pair_candidates_lists(
                    p_a, p_b, expected_axis=expected_axis, grid_cfg=grid_cfg
                )
            return _pair_cands_cache[key]

        def inset_10mm_bounds_for_axis(
            pk: int,
            axis: str,
        ) -> Optional[Tuple[float, float]]:
            if (
                page_count < 2
                or expected_overlap is not None
                or expectations.get("checkPage1PieceBounds", False)
                or expectations.get("marginMm") is not None
                or pk not in info_by_page
            ):
                return None
            info_pk = info_by_page[pk]
            if info_pk["frame"] is not None:
                return None
            pw_pk, ph_pk = get_page_dims_mm(pk)
            pw_pt_pk, ph_pt_pk = page_dims_pt.get(pk, (page_w_pt, page_h_pt))
            if axis == "x":
                dim_mm = pw_pk
                ctm_origin = 0.5 * (pw_pt_pk - math.ceil(pw_pt_pk)) * pt_to_mm
                reg_min, reg_max = info_pk["regXMin"], info_pk["regXMax"]
            else:
                dim_mm = ph_pk
                ctm_origin = 0.5 * (ph_pt_pk - math.ceil(ph_pt_pk)) * pt_to_mm
                reg_min, reg_max = info_pk["regYMin"], info_pk["regYMax"]
            if reg_min is None or reg_max is None:
                return None
            m_l = reg_min - ctm_origin
            m_r = dim_mm - (reg_max - ctm_origin)
            if not (10.5 < m_l <= 13.5 and abs(m_l - m_r) <= 1.5):
                return None
            return 10.0 + ctm_origin, dim_mm - 10.0 + ctm_origin

        def is_piece_inset_exempt_on_axis(
            s: Dict[str, Any],
            pk: int,
            axis: str,
            side: str,
            is_first_pos: bool,
            is_final_pos: bool,
            axis_is_tiled: bool,
            active_axis_s1_ids: set,
            active_axis_s2_ids: set,
            active_other_ids: set,
        ) -> bool:
            b10 = inset_10mm_bounds_for_axis(pk, axis)
            if b10 is None:
                return False
            info_pk = info_by_page[pk]
            if axis == "x":
                reg_min, reg_max = info_pk["regXMin"], info_pk["regXMax"]
                s_min, s_max = s["minX"], s["maxX"]
            else:
                reg_min, reg_max = info_pk["regYMin"], info_pk["regYMax"]
                s_min, s_max = s["minY"], s["maxY"]
            if reg_min is None or reg_max is None:
                return False
            if side in ("max", "both") and s_max > b10[1] + 1.0:
                return False
            if side in ("min", "both") and s_min < b10[0] - 1.0:
                return False
            is_symmetric_outer_first = (
                is_first_pos
                and axis_is_tiled
                and s_min < reg_min - 0.25
                and s_max > reg_max + 0.25
                and s_min >= b10[0] - 1.0
                and s_max <= b10[1] + 1.0
            )
            is_untiled_crossing = (
                not axis_is_tiled
                and id(s) in active_other_ids
                and s_min >= b10[0] - 1.0
                and s_max <= b10[1] + 1.0
            )
            if side == "max":
                if is_final_pos:
                    return (
                        (id(s) in active_axis_s2_ids)
                        or is_untiled_crossing
                        or (axis_is_tiled and s_min >= reg_min - 1.0)
                        or is_symmetric_outer_first
                        or (axis_is_tiled and id(s) in active_other_ids)
                    )
                return (
                    (id(s) in active_axis_s1_ids)
                    or is_untiled_crossing
                    or is_symmetric_outer_first
                    or (axis_is_tiled and id(s) in active_other_ids)
                )
            if side == "min":
                return (
                    (id(s) in active_axis_s1_ids)
                    or (id(s) in active_axis_s2_ids)
                    or is_untiled_crossing
                    or (axis_is_tiled and id(s) in active_other_ids)
                    or (axis_is_tiled and is_first_pos and s_max <= reg_max + 1.0)
                    or is_symmetric_outer_first
                )
            return False

        def overflowing_pieces_for_axis(
            pk: int,
            axis: str,
            box_map: Optional[Dict[int, Tuple[float, float, float, float]]] = None,
        ) -> List[Dict[str, Any]]:
            if pk not in page_shapes_by_num:
                return []
            target_map = box_by_page if box_map is None else box_map
            box_pk = target_map[pk]
            pw_pk, ph_pk = get_page_dims_mm(pk)
            if axis == "x":
                limit_x = box_pk[2] if box_pk[2] is not None else pw_pk
                return [s for s in pieces_by_page[pk] if s["maxX"] > limit_x + 1.0]
            limit_y = box_pk[3] if box_pk[3] is not None else ph_pk
            return [s for s in pieces_by_page[pk] if s["maxY"] > limit_y + 1.0]

        # Pre-infer 2D grid stride (inferred_cols, wrap_kind) via global hypothesis scoring
        inferred_cols: Optional[int] = None
        wrap_kind: Optional[str] = None
        if page_count >= 3:
            divisors_2d = [d for d in range(2, page_count) if page_count % d == 0]
            candidates: List[Tuple[str, int]] = []
            for d in divisors_2d:
                candidates.append(("row", d))
                candidates.append(("col", d))
            candidates.append(("row", page_count))
            candidates.append(("col", page_count))

            best_score: Optional[Tuple[int, int, int, int, int, int, int]] = None
            best_choice: Optional[Tuple[str, int]] = None

            def _pair_has_verified_tail(p_a: int, p_b: int, ax: str, ref_ovs: List[float], grid_cfg: Any = None) -> bool:
                box_a = box_by_page[p_a]
                box_b = box_by_page[p_b]
                ubox_a = unshifted_box_by_page[p_a]
                ubox_b = unshifted_box_by_page[p_b]
                if box_a[0] is None or box_b[0] is None:
                    return False
                ov_tol_t = max(40.0, float(expected_overlap) + 1.0) if expected_overlap is not None else 40.0
                pw_pa_pt, ph_pa_pt = page_dims_pt.get(p_a, (page_w_pt, page_h_pt))
                pw_pb_pt, ph_pb_pt = page_dims_pt.get(p_b, (page_w_pt, page_h_pt))
                ctm_dx_t = 0.5 * ((pw_pa_pt - math.ceil(pw_pa_pt)) - (pw_pb_pt - math.ceil(pw_pb_pt))) * pt_to_mm
                ctm_dy_t = 0.5 * ((ph_pa_pt - math.ceil(ph_pa_pt)) - (ph_pb_pt - math.ceil(ph_pb_pt))) * pt_to_mm
                lo_idx, hi_idx = (0, 2) if ax == "x" else (1, 3)
                min_k, max_k = ("minX", "maxX") if ax == "x" else ("minY", "maxY")
                solids_b = _get_solids_for_page(p_b)
                for s2 in pieces_by_page.get(p_b, []):
                    if not (s2[min_k] < box_b[lo_idx] - 1.0 and s2[max_k] < box_b[lo_idx] - 1.0):
                        continue
                    if not s2.get("dashed"):
                        if (
                            s2[max_k] < box_b[lo_idx] - 2.5
                            and not _piece_has_aux_bleed(p_b, s2, ax, "min", box_b[lo_idx], grid_cfg=grid_cfg)
                        ):
                            continue
                    else:
                        if s2[max_k] < box_b[lo_idx] - 25.0:
                            continue
                    for s1 in pieces_by_page.get(p_a, []):
                        if bool(s1.get("dashed")) != bool(s2.get("dashed")):
                            continue
                        if abs(s1["widthMm"] - s2["widthMm"]) > 0.1 + FLOAT_CMP_EPS or abs(s1["heightMm"] - s2["heightMm"]) > 0.1 + FLOAT_CMP_EPS:
                            continue
                        area_tol_t = max(1.0, 0.01 * max(s1["areaMm2"], s2["areaMm2"]))
                        if abs(s1["areaMm2"] - s2["areaMm2"]) > area_tol_t:
                            continue
                        dx_t = (s1["minX"] - s2["minX"]) - ctm_dx_t
                        dy_t = (s1["minY"] - s2["minY"]) - ctm_dy_t
                        step_t = dx_t if ax == "x" else dy_t
                        res_t = dy_t if ax == "x" else dx_t
                        if step_t <= 10.0 or abs(res_t) > 0.1 + FLOAT_CMP_EPS:
                            continue
                        if s2.get("dashed"):
                            enclosing_sols = _get_enclosing_sols(p_a, s1)
                            if not enclosing_sols or not any(
                                any(
                                    abs(sol["widthMm"] - s2_sol["widthMm"]) <= 0.1 + FLOAT_CMP_EPS
                                    and abs(sol["heightMm"] - s2_sol["heightMm"]) <= 0.1 + FLOAT_CMP_EPS
                                    and abs((sol["minX"] - s2_sol["minX"]) - ctm_dx_t - dx_t) <= 0.1 + FLOAT_CMP_EPS
                                    and abs((sol["minY"] - s2_sol["minY"]) - ctm_dy_t - dy_t) <= 0.1 + FLOAT_CMP_EPS
                                    and (
                                        sol[max_k] >= step_t + box_b[lo_idx] - 2.5
                                        or _piece_has_aux_bleed(p_b, s2_sol, ax, "min", box_b[lo_idx], grid_cfg=grid_cfg)
                                    )
                                    and shifted_polygon_max_error(
                                        sol["points"], s2_sol["points"], sol["minX"] - s2_sol["minX"], sol["minY"] - s2_sol["minY"]
                                    ) <= 0.1 + FLOAT_CMP_EPS
                                    for s2_sol in solids_b
                                )
                                for sol in enclosing_sols
                            ):
                                continue
                        if s1[max_k] < box_a[hi_idx] - ov_tol_t:
                            continue
                        imp_ov = (ubox_a[hi_idx] - ubox_b[lo_idx]) - step_t
                        if imp_ov < -0.1 - FLOAT_CMP_EPS or imp_ov > ov_tol_t:
                            continue
                        if expected_overlap is not None and abs(imp_ov - float(expected_overlap)) > 0.1 + FLOAT_CMP_EPS:
                            continue
                        if ref_ovs and any(abs(imp_ov - r_ov) > 0.1 + FLOAT_CMP_EPS for r_ov in ref_ovs):
                            continue
                        if shifted_polygon_max_error(s1["points"], s2["points"], s1["minX"] - s2["minX"], s1["minY"] - s2["minY"]) <= 0.1 + FLOAT_CMP_EPS:
                            return True
                return False

            for kind, S in candidates:
                inner_ax = "x" if kind == "row" else "y"
                outer_ax = "y" if kind == "row" else "x"

                unmatched_inner = 0
                unmatched_outer = 0
                non_ortho_count = 0
                total_ortho_matched = 0
                cand_s1_in: Dict[int, set] = {pk: set() for pk in checked_keys}
                cand_s2_in: Dict[int, set] = {pk: set() for pk in checked_keys}
                cand_s1_out: Dict[int, set] = {pk: set() for pk in checked_keys}
                cand_s2_out: Dict[int, set] = {pk: set() for pk in checked_keys}
                cand_any_in = False
                cand_any_out = False

                cand_in_pairs: List[Tuple[int, List[Dict[str, Any]], set]] = []
                cand_out_pairs: List[Tuple[int, List[Dict[str, Any]], set]] = []
                cand_pair_edges: List[Tuple[int, int, str]] = []
                cand_ref_ovs: List[float] = []

                for p_a in range(1, page_count):
                    if p_a % S == 0:
                        continue
                    p_b = p_a + 1
                    if p_a not in page_shapes_by_num or p_b not in page_shapes_by_num:
                        continue
                    ov_pieces = overflowing_pieces_for_axis(p_a, inner_ax, box_map=overflow_box_by_page)
                    _, pm, _ = get_pair_cands(p_a, p_b, expected_axis=inner_ax, grid_cfg=(kind, S))
                    cand_pair_edges.append((p_a, p_b, inner_ax))
                    if pm:
                        cand_any_in = True
                    matched_ids = {id(s1) for s1, _, _, _ in pm}
                    for s1, s2, dx, dy in pm:
                        cand_s1_in[p_a].add(id(s1))
                        cand_s2_in[p_b].add(id(s2))
                        if min(abs(dx), abs(dy)) <= 0.1 + FLOAT_CMP_EPS:
                            step = dx if inner_ax == "x" else dy
                            if step > 10.0:
                                total_ortho_matched += 1
                                ba, bb = unshifted_box_by_page[p_a], unshifted_box_by_page[p_b]
                                if ba[0] is not None and bb[0] is not None:
                                    cand_ref_ovs.append(((ba[2] - bb[0]) if inner_ax == "x" else (ba[3] - bb[1])) - step)
                        else:
                            non_ortho_count += 1
                    cand_in_pairs.append((p_a, ov_pieces, matched_ids))

                if S < page_count:
                    for p_a in range(1, page_count - S + 1):
                        p_b = p_a + S
                        if p_a not in page_shapes_by_num or p_b not in page_shapes_by_num:
                            continue
                        ov_pieces = overflowing_pieces_for_axis(p_a, outer_ax, box_map=overflow_box_by_page)
                        _, pm, _ = get_pair_cands(p_a, p_b, expected_axis=outer_ax, grid_cfg=(kind, S))
                        cand_pair_edges.append((p_a, p_b, outer_ax))
                        if pm:
                            cand_any_out = True
                        matched_ids = {id(s1) for s1, _, _, _ in pm}
                        for s1, s2, dx, dy in pm:
                            cand_s1_out[p_a].add(id(s1))
                            cand_s2_out[p_b].add(id(s2))
                            if min(abs(dx), abs(dy)) <= 0.1 + FLOAT_CMP_EPS:
                                step = dy if outer_ax == "y" else dx
                                if step > 10.0:
                                    total_ortho_matched += 1
                                    ba, bb = unshifted_box_by_page[p_a], unshifted_box_by_page[p_b]
                                    if ba[0] is not None and bb[0] is not None:
                                        cand_ref_ovs.append(((ba[3] - bb[1]) if outer_ax == "y" else (ba[2] - bb[0])) - step)
                            else:
                                non_ortho_count += 1
                        cand_out_pairs.append((p_a, ov_pieces, matched_ids))

                verified_tail_matched = sum(
                    1 for pa_e, pb_e, ax_e in cand_pair_edges
                    if _pair_has_verified_tail(pa_e, pb_e, ax_e, cand_ref_ovs, grid_cfg=(kind, S))
                )

                for p_a, ov_pieces, matched_ids in cand_in_pairs:
                    act_other_in = cand_s1_out[p_a] | cand_s2_out[p_a]
                    is_first_in = ((p_a - 1) % S == 0)
                    unmatched_inner += sum(
                        1 for s in ov_pieces
                        if id(s) not in matched_ids
                        and not is_piece_inset_exempt_on_axis(
                            s, p_a, inner_ax, "max", is_first_in, False, cand_any_in,
                            cand_s1_in[p_a], cand_s2_in[p_a], act_other_in,
                        )
                    )
                for p_a, ov_pieces, matched_ids in cand_out_pairs:
                    act_other_out = cand_s1_in[p_a] | cand_s2_in[p_a]
                    is_first_out = (p_a <= S)
                    unmatched_outer += sum(
                        1 for s in ov_pieces
                        if id(s) not in matched_ids
                        and not is_piece_inset_exempt_on_axis(
                            s, p_a, outer_ax, "max", is_first_out, False, cand_any_out,
                            cand_s1_out[p_a], cand_s2_out[p_a], act_other_out,
                        )
                    )

                boundary_overflows = 0
                for pk in checked_keys:
                    act_other_for_in = cand_s1_out[pk] | cand_s2_out[pk]
                    act_other_for_out = cand_s1_in[pk] | cand_s2_in[pk]
                    is_first_in_pk = ((pk - 1) % S == 0)
                    is_first_out_pk = (pk <= S)
                    if pk % S == 0:
                        for s in overflowing_pieces_for_axis(pk, inner_ax, box_map=overflow_box_by_page):
                            if not is_piece_inset_exempt_on_axis(
                                s, pk, inner_ax, "max", is_first_in_pk, True, cand_any_in,
                                cand_s1_in[pk], cand_s2_in[pk], act_other_for_in,
                            ):
                                boundary_overflows += 1
                    if pk > page_count - S:
                        for s in overflowing_pieces_for_axis(pk, outer_ax, box_map=overflow_box_by_page):
                            if not is_piece_inset_exempt_on_axis(
                                s, pk, outer_ax, "max", is_first_out_pk, True, cand_any_out,
                                cand_s1_out[pk], cand_s2_out[pk], act_other_for_out,
                            ):
                                boundary_overflows += 1

                total_unmatched = boundary_overflows + unmatched_inner + unmatched_outer
                score = (
                    total_unmatched,
                    boundary_overflows,
                    non_ortho_count,
                    -total_ortho_matched,
                    -verified_tail_matched,
                    0 if kind == "row" else 1,
                    0 if S == page_count else 1,
                )
                if best_score is None or score < best_score:
                    best_score = score
                    best_choice = (kind, S)

            if best_choice is not None:
                wrap_kind, inferred_cols = best_choice

        pair_candidates: List[Tuple[int, int]] = [
            (checked_keys[i], checked_keys[i + 1])
            for i in range(len(checked_keys) - 1)
            if checked_keys[i + 1] == checked_keys[i] + 1
        ]
        if not pair_candidates and len(checked_keys) >= 2:
            pair_candidates = [(checked_keys[0], checked_keys[1])]
        seen_pairs = set(pair_candidates)
        if inferred_cols is not None and inferred_cols >= 2:
            for pk in checked_keys:
                vp = (pk, pk + inferred_cols)
                if (pk + inferred_cols) in page_shapes_by_num and vp not in seen_pairs:
                    seen_pairs.add(vp)
                    pair_candidates.append(vp)

        matched_any_pair = False
        matched_x_any = False
        matched_y_any = False
        emitted_p1_overflow = False
        broken_wrap_detected = False
        matched_s1_x: Dict[int, set] = {pk: set() for pk in checked_keys}
        matched_s1_y: Dict[int, set] = {pk: set() for pk in checked_keys}
        matched_s2_x: Dict[int, set] = {pk: set() for pk in checked_keys}
        matched_s2_y: Dict[int, set] = {pk: set() for pk in checked_keys}

        pair_overflow_records: List[Tuple[int, int, Optional[str], set]] = []
        final_grid_cfg = (wrap_kind, inferred_cols) if (wrap_kind is not None and inferred_cols is not None) else None

        for p_a, p_b in pair_candidates:
            info_a = info_by_page[p_a]
            frame_a = info_a["frame"]
            pieces_a = pieces_by_page[p_a]
            box_a = box_by_page[p_a]
            box_b = box_by_page[p_b]
            ubox_a = unshifted_box_by_page[p_a]
            ubox_b = unshifted_box_by_page[p_b]
            pw_a, ph_a = get_page_dims_mm(p_a)
            pw_b, ph_b = get_page_dims_mm(p_b)

            is_stride_pair = inferred_cols is not None and p_b == p_a + inferred_cols and p_b != p_a + 1
            hint_axis: Optional[str] = None
            if is_stride_pair:
                hint_axis = "x" if wrap_kind == "col" else "y"
            elif page_count >= 3 and p_b == p_a + 1 and inferred_cols is not None and inferred_cols >= 2 and (p_a % inferred_cols != 0):
                hint_axis = "y" if wrap_kind == "col" else "x"

            size_matched, pair_matches, wrap_candidates = get_pair_cands(
                p_a, p_b, expected_axis=hint_axis, grid_cfg=final_grid_cfg
            )

            is_wrap_pair = False
            if page_count >= 3 and p_b == p_a + 1 and inferred_cols is not None and (p_a % inferred_cols == 0):
                is_wrap_pair = True
                outer_ax_w = "y" if wrap_kind == "row" else "x"
                matched_outer_s1 = set()
                if (p_a + inferred_cols) in page_shapes_by_num:
                    _, pm_oa, _ = get_pair_cands(
                        p_a, p_a + inferred_cols, expected_axis=outer_ax_w, grid_cfg=final_grid_cfg
                    )
                    matched_outer_s1 = {id(m[0]) for m in pm_oa}
                matched_outer_s2 = set()
                if (p_b - inferred_cols) in page_shapes_by_num:
                    _, pm_ob, _ = get_pair_cands(
                        p_b - inferred_cols, p_b, expected_axis=outer_ax_w, grid_cfg=final_grid_cfg
                    )
                    matched_outer_s2 = {id(m[1]) for m in pm_ob}
                valid_wrap_s1 = set()
                valid_wrap_s2 = set()
                for ws1, ws2, wdx, wdy in wrap_candidates:
                    if is_true_wrap_candidate(ws1, ws2, wdx, wdy, box_a, box_b, pw_a, ph_a):
                        valid_wrap_s1.add(id(ws1))
                        valid_wrap_s2.add(id(ws2))
                obox_w_a = overflow_box_by_page[p_a]
                obox_w_b = overflow_box_by_page[p_b]
                if wrap_kind == "row" and any(
                    dy <= 10.0
                    and id(s1) not in valid_wrap_s1
                    and id(s2) not in valid_wrap_s2
                    and (
                        (obox_w_a[3] is not None and s1["maxY"] > obox_w_a[3] + 1.0 and id(s1) not in matched_outer_s1)
                        or (obox_w_b[1] is not None and s2["minY"] < obox_w_b[1] - 1.0 and id(s2) not in matched_outer_s2)
                    )
                    for s1, s2, dx, dy in size_matched
                ):
                    broken_wrap_detected = True
                    errors.append(
                        f"E08 row wrap between page {p_a} and page {p_b} has invalid vertical step (dy <= 10.0 mm)"
                    )
                elif wrap_kind == "col" and any(
                    dx <= 10.0
                    and id(s1) not in valid_wrap_s1
                    and id(s2) not in valid_wrap_s2
                    and (
                        (obox_w_a[2] is not None and s1["maxX"] > obox_w_a[2] + 1.0 and id(s1) not in matched_outer_s1)
                        or (obox_w_b[0] is not None and s2["minX"] < obox_w_b[0] - 1.0 and id(s2) not in matched_outer_s2)
                    )
                    for s1, s2, dx, dy in size_matched
                ):
                    broken_wrap_detected = True
                    errors.append(
                        f"E08 column wrap between page {p_a} and page {p_b} has invalid horizontal step (dx <= 10.0 mm)"
                    )
                pair_matches = []

            if is_wrap_pair:
                continue

            if is_stride_pair:
                pair_axis: Optional[str] = "x" if wrap_kind == "col" else "y"
            elif pair_matches:
                x_cnt = sum(1 for _, _, dx, dy in pair_matches if dx >= dy)
                pair_axis = "x" if x_cnt >= (len(pair_matches) - x_cnt) else "y"
            elif wrap_kind == "row" and inferred_cols is not None and inferred_cols >= 2:
                pair_axis = "x"
            elif wrap_kind == "col" and inferred_cols is not None and inferred_cols >= 2:
                pair_axis = "y"
            elif p_a == 1 and p_b == 2:
                pair_axis = None
            elif matched_y_any and not matched_x_any:
                pair_axis = "y"
            else:
                pair_axis = None

            if pair_matches:
                matched_any_pair = True
                max_err_for_pair = 0.0
                if len(pair_matches) >= 2:
                    dxs_pair = [m[2] for m in pair_matches]
                    dys_pair = [m[3] for m in pair_matches]
                    if (max(dxs_pair) - min(dxs_pair)) > 0.1 + FLOAT_CMP_EPS or (max(dys_pair) - min(dys_pair)) > 0.1 + FLOAT_CMP_EPS:
                        errors.append(
                            f"E08 inconsistent tile steps between page {p_a} and page {p_b} (dx=[{min(dxs_pair):.3f}, {max(dxs_pair):.3f}]mm, dy=[{min(dys_pair):.3f}, {max(dys_pair):.3f}]mm)"
                        )
                for s1, s2, dx, dy in pair_matches:
                    if min(abs(dx), abs(dy)) > 0.1 + FLOAT_CMP_EPS:
                        errors.append(
                            f"E08 tile step between page {p_a} and page {p_b} is not orthogonal (dx={dx:.3f}mm, dy={dy:.3f}mm)"
                        )
                        continue
                    axis = "x" if dx >= dy else "y"
                    if axis == "x":
                        matched_x_any = True
                    else:
                        matched_y_any = True
                    step = dx if axis == "x" else dy
                    if step <= 10.0:
                        errors.append(f"E08 invalid tile step {step:.3f}mm between page {p_a} and page {p_b}")
                        continue
                    if axis == "x":
                        matched_s1_x[p_a].add(id(s1))
                        matched_s2_x[p_b].add(id(s2))
                    else:
                        matched_s1_y[p_a].add(id(s1))
                        matched_s2_y[p_b].add(id(s2))
                    poly_err = shifted_polygon_max_error(
                        s1["points"], s2["points"], s1["minX"] - s2["minX"], s1["minY"] - s2["minY"]
                    )
                    if poly_err > max_err_for_pair:
                        max_err_for_pair = poly_err
                    if poly_err > 0.1 + FLOAT_CMP_EPS:
                        errors.append(
                            f"E08 page {p_a}->page {p_b} piece parity error {poly_err:.4f}mm exceeds 0.1 mm tolerance"
                        )
                    else:
                        uf_union((p_a, id(s1)), (p_b, id(s2)))
                        if not s1.get("dashed"):
                            s_shift_x = s1["minX"] - s2["minX"]
                            s_shift_y = s1["minY"] - s2["minY"]
                            dashed_b = [d2 for d2 in pieces_by_page[p_b] if d2.get("dashed")]
                            if dashed_b:
                                for d1 in pieces_by_page[p_a]:
                                    if not d1.get("dashed"):
                                        continue
                                    if s1 not in _get_enclosing_sols(p_a, d1):
                                        continue
                                    for d2 in dashed_b:
                                        if (
                                            abs(d1["widthMm"] - d2["widthMm"]) <= 0.1 + FLOAT_CMP_EPS
                                            and abs(d1["heightMm"] - d2["heightMm"]) <= 0.1 + FLOAT_CMP_EPS
                                            and abs((d1["minX"] - d2["minX"]) - s_shift_x) <= 0.1 + FLOAT_CMP_EPS
                                            and abs((d1["minY"] - d2["minY"]) - s_shift_y) <= 0.1 + FLOAT_CMP_EPS
                                            and shifted_polygon_max_error(
                                                d1["points"], d2["points"], d1["minX"] - d2["minX"], d1["minY"] - d2["minY"]
                                            ) <= 0.1 + FLOAT_CMP_EPS
                                        ):
                                            uf_union((p_a, id(d1)), (p_b, id(d2)))

                    reg_span = info_a["regSpanX"] if axis == "x" else info_a["regSpanY"]
                    reg_min = info_a["regXMin"] if axis == "x" else info_a["regYMin"]
                    reg_max = info_a["regXMax"] if axis == "x" else info_a["regYMax"]
                    page_dim_a = pw_a if axis == "x" else ph_a
                    pw_pt_a, ph_pt_a = page_dims_pt.get(p_a, (page_w_pt, page_h_pt))
                    dim_a_pt_val = pw_pt_a if axis == "x" else ph_pt_a
                    ctm_origin_a = 0.5 * (dim_a_pt_val - math.ceil(dim_a_pt_val)) * pt_to_mm
                    has_opposite_reg = (
                        reg_span is not None
                        and reg_span > 10.0
                        and reg_min is not None
                        and reg_max is not None
                        and reg_min <= min(50.0, 0.35 * page_dim_a)
                        and reg_max >= max(page_dim_a - 50.0, 0.65 * page_dim_a)
                    )

                    printable_span: Optional[float] = None
                    if frame_a is not None:
                        printable_span = frame_a["widthMm"] if axis == "x" else frame_a["heightMm"]
                    elif expectations.get("marginMm") is not None:
                        printable_span = page_dim_a - 2.0 * float(expectations["marginMm"])
                    elif _is_all_interior_drill_marks(info_a, p_a) and not _axis_uses_reg_span_for_drills(info_a, p_a, axis):
                        printable_span = (ubox_a[2] - ubox_a[0]) if axis == "x" else (ubox_a[3] - ubox_a[1])
                    elif has_opposite_reg:
                        printable_span = reg_span
                    elif reg_min is not None:
                        true_reg_min = reg_min - ctm_origin_a
                        has_lo_reg = -0.15 <= true_reg_min <= 35.0
                        has_hi_reg = reg_max is not None and reg_max >= max(page_dim_a - 50.0, 0.65 * page_dim_a)
                        if has_lo_reg or has_hi_reg:
                            printable_span = (ubox_a[2] - ubox_a[0]) if axis == "x" else (ubox_a[3] - ubox_a[1])
                    elif not expectations.get("requireRegistrationMarks", True):
                        printable_span = page_dim_a

                    if tile_step_mm is None:
                        tile_step_mm = step
                    if axis not in first_step_by_axis:
                        first_step_by_axis[axis] = (step, page_dim_a)
                    elif (
                        abs(page_dim_a - first_step_by_axis[axis][1]) <= 0.5
                        and abs(step - first_step_by_axis[axis][0]) > 0.1 + FLOAT_CMP_EPS
                    ):
                        errors.append(
                            f"E08 inconsistent {axis}-axis tile step between page {p_a} and page {p_b} ({step:.3f}mm vs {first_step_by_axis[axis][0]:.3f}mm)"
                        )
                    lo_idx, hi_idx = (0, 2) if axis == "x" else (1, 3)
                    has_both_boxes = (
                        ubox_a[lo_idx] is not None
                        and ubox_a[hi_idx] is not None
                        and ubox_b[lo_idx] is not None
                        and ubox_b[hi_idx] is not None
                    )
                    if has_both_boxes:
                        box_a_span = ubox_a[hi_idx] - ubox_a[lo_idx]
                        box_b_span = ubox_b[hi_idx] - ubox_b[lo_idx]
                        same_page_orient = abs(pw_a - pw_b) <= 0.5 and abs(ph_a - ph_b) <= 0.5
                        if same_page_orient:
                            if (
                                abs(ubox_a[lo_idx] - ubox_b[lo_idx]) > 0.15 + FLOAT_CMP_EPS
                                or abs(ubox_a[hi_idx] - ubox_b[hi_idx]) > 0.15 + FLOAT_CMP_EPS
                                or abs(box_a_span - box_b_span) > 0.15 + FLOAT_CMP_EPS
                            ):
                                if (p_a, p_b, axis) not in reported_box_inconsistency:
                                    reported_box_inconsistency.add((p_a, p_b, axis))
                                    errors.append(
                                        f"E08 inconsistent {axis}-axis printable box between page {p_a} ([{ubox_a[lo_idx]:.2f}, {ubox_a[hi_idx]:.2f}]) and page {p_b} ([{ubox_b[lo_idx]:.2f}, {ubox_b[hi_idx]:.2f}])"
                                    )
                        elif p_a in margins_by_page and p_b in margins_by_page:
                            ma = margins_by_page[p_a]
                            mb = margins_by_page[p_b]
                            s_lo, s_hi = (0, 1) if axis == "x" else (2, 3)
                            if (
                                abs(ma[s_lo] - mb[s_lo]) > 0.15 + FLOAT_CMP_EPS
                                or abs(ma[s_hi] - mb[s_hi]) > 0.15 + FLOAT_CMP_EPS
                            ):
                                if (p_a, p_b, axis) not in reported_box_inconsistency:
                                    reported_box_inconsistency.add((p_a, p_b, axis))
                                    reported_box_inconsistency.add((p_b, p_a, axis))
                                    errors.append(
                                        f"E08 inconsistent {axis}-axis printable margins between mixed-orientation page {p_a} (({ma[s_lo]:.2f}, {ma[s_hi]:.2f})) and page {p_b} (({mb[s_lo]:.2f}, {mb[s_hi]:.2f}))"
                                    )
                    if printable_span is not None:
                        if has_both_boxes:
                            box_overlap = (ubox_a[hi_idx] - ubox_b[lo_idx]) - step
                            if abs(printable_span - box_a_span) <= 0.5:
                                overlap = box_overlap
                            else:
                                overlap = (
                                    box_overlap
                                    if (expected_overlap is not None and abs(box_overlap - float(expected_overlap)) > 0.1 + FLOAT_CMP_EPS)
                                    else (printable_span - step)
                                )
                        else:
                            overlap = printable_span - step
                        if measured_overlap_mm is None:
                            measured_overlap_mm = overlap
                        if axis not in first_overlap_by_axis:
                            first_overlap_by_axis[axis] = overlap
                        elif abs(overlap - first_overlap_by_axis[axis]) > 0.1 + FLOAT_CMP_EPS:
                            errors.append(
                                f"E08 inconsistent {axis}-axis tile overlap between page {p_a} and page {p_b} ({overlap:.3f}mm vs {first_overlap_by_axis[axis]:.3f}mm)"
                            )
                        if overlap < -0.1 - FLOAT_CMP_EPS:
                            errors.append(
                                f"E08 negative tile overlap ({overlap:.3f}mm) between page {p_a} and page {p_b} leaves a gap"
                            )
                        if expected_overlap is not None and abs(overlap - float(expected_overlap)) > 0.1 + FLOAT_CMP_EPS:
                            errors.append(
                                f"E08 measured tile overlap {overlap:.3f}mm differs from expected {float(expected_overlap):.3f}mm by > 0.1 mm"
                            )
                        if has_opposite_reg and (not _is_all_interior_drill_marks(info_a, p_a) or _axis_uses_reg_span_for_drills(info_a, p_a, axis)) and reg_span < printable_span - 0.5:
                            if abs(step - reg_span) > 0.1 + FLOAT_CMP_EPS:
                                errors.append(
                                    f"E08 tile step {step:.3f}mm differs from registration mark span {reg_span:.3f}mm by > 0.1 mm"
                                )
                    elif expected_overlap is not None:
                        errors.append(
                            f"E08 cannot verify expected tile overlap {float(expected_overlap):.3f}mm between page {p_a} and page {p_b}: printable_span could not be determined from tile border frame, marginMm, or registration marks"
                        )
                if tile_parity_max_err_mm is None or max_err_for_pair > tile_parity_max_err_mm:
                    tile_parity_max_err_mm = max_err_for_pair

            # Detect unshifted overflowing duplicates on non-wrap pairs (e.g., broken dy=0 across Row 1->2 or dx=0/5 on adjacent pairs)
            if not is_wrap_pair:
                obox_d_a = overflow_box_by_page[p_a]
                obox_d_b = overflow_box_by_page[p_b]
                dup_axis = hint_axis if hint_axis in ("x", "y") else pair_axis
                matched_stride_s1 = {id(m[0]) for m in pair_matches}
                matched_stride_s2 = {id(m[1]) for m in pair_matches}
                if dup_axis in ("y", None) and any(
                    abs(dx) <= 0.1 + FLOAT_CMP_EPS and dy <= 10.0
                    and id(s1) not in matched_stride_s1
                    and id(s2) not in matched_stride_s2
                    and (
                        (obox_d_a[3] is not None and s1["maxY"] > obox_d_a[3] + 1.0 and s1["minY"] >= obox_d_a[1] - 1.0)
                        or (obox_d_b[1] is not None and s2["minY"] < obox_d_b[1] - 1.0)
                    )
                    for s1, s2, dx, dy in size_matched
                ):
                    broken_wrap_detected = True
                    errors.append(
                        f"E08 vertical progression between page {p_a} and page {p_b} has invalid vertical step (dy <= 10.0 mm)"
                    )
                if dup_axis in ("x", None) and any(
                    abs(dy) <= 0.1 + FLOAT_CMP_EPS and dx <= 10.0
                    and id(s1) not in matched_stride_s1
                    and id(s2) not in matched_stride_s2
                    and (
                        (obox_d_a[2] is not None and s1["maxX"] > obox_d_a[2] + 1.0 and s1["minX"] >= obox_d_a[0] - 1.0)
                        or (obox_d_b[0] is not None and s2["minX"] < obox_d_b[0] - 1.0)
                    )
                    for s1, s2, dx, dy in size_matched
                ):
                    broken_wrap_detected = True
                    errors.append(
                        f"E08 horizontal progression between page {p_a} and page {p_b} has invalid horizontal step (dx <= 10.0 mm)"
                    )

            # Record overflow check until matched_s1/matched_s2 and is_final_exempt are finalized
            obox_a = overflow_box_by_page[p_a]
            if obox_a[2] is not None and obox_a[3] is not None:
                matched_s1_ids = {id(s1) for s1, _, _, _ in pair_matches}
                pair_overflow_records.append((p_a, p_b, pair_axis, matched_s1_ids))

        if (
            expected_overlap is None
            and "x" in first_overlap_by_axis
            and "y" in first_overlap_by_axis
            and abs(first_overlap_by_axis["x"] - first_overlap_by_axis["y"]) > 0.1 + FLOAT_CMP_EPS
        ):
            errors.append(
                f"E08 inconsistent cross-axis tile overlap between x-axis ({first_overlap_by_axis['x']:.3f}mm) and y-axis ({first_overlap_by_axis['y']:.3f}mm)"
            )

        def _has_mediabox_culled_ortho_tail_aux(
            pk: int,
            s: Dict[str, Any],
            axis: str,
            bound_val: float,
        ) -> bool:
            if s.get("dashed"):
                return False
            ortho_s1 = matched_s1_y.get(pk, set()) if axis == "x" else matched_s1_x.get(pk, set())
            ortho_s2 = matched_s2_y.get(pk, set()) if axis == "x" else matched_s2_x.get(pk, set())
            if id(s) not in ortho_s1 and id(s) not in ortho_s2:
                return False
            max_k = "maxX" if axis == "x" else "maxY"
            if (bound_val - s[max_k]) > 18.0:
                return False
            s_pts = s.get("points") or []
            if not s_pts:
                return False
            box_pk = box_by_page.get(pk)
            pw_pk_m, ph_pk_m = get_page_dims_mm(pk)
            ortho_dim_pk = ph_pk_m if axis == "x" else pw_pk_m
            o_min_k, o_max_k = ("minY", "maxY") if axis == "x" else ("minX", "maxX")
            o_lo_idx, o_hi_idx = (1, 3) if axis == "x" else (0, 2)
            ortho_ax = "y" if axis == "x" else "x"
            ov_tol_mb = max(30.0, float(expected_overlap) + 1.0) if expected_overlap is not None else 30.0
            u_step = _infer_ortho_step(ortho_ax, final_grid_cfg)
            inferred_ov_mb: Optional[float] = None
            if expected_overlap is None:
                inferred_ov_mb = _infer_axis_overlap(ortho_ax, final_grid_cfg)
                if inferred_ov_mb is None:
                    inferred_ov_mb = _infer_axis_overlap(axis, final_grid_cfg)
            target_ov_mb = float(expected_overlap) if expected_overlap is not None else inferred_ov_mb
            for qk in checked_keys:
                if qk == pk:
                    continue
                d_o = _ortho_neighbor_sign(pk, qk, axis, final_grid_cfg)
                if d_o is None:
                    continue
                if (d_o > 0 and id(s) not in ortho_s1) or (d_o < 0 and id(s) not in ortho_s2):
                    continue
                aux_qk = _get_aux_shapes_for_page(qk)
                if not aux_qk:
                    continue
                box_qk = box_by_page.get(qk)
                if box_qk is None or box_qk[o_lo_idx] is None or box_qk[o_hi_idx] is None:
                    continue
                for st in _get_solids_for_page(qk):
                    if (
                        abs(st["widthMm"] - s["widthMm"]) > 0.25
                        or abs(st["heightMm"] - s["heightMm"]) > 0.25
                        or abs(st["areaMm2"] - s["areaMm2"]) > max(1.0, 0.02 * s["areaMm2"])
                    ):
                        continue
                    dx_align = s["minX"] - st["minX"]
                    dy_align = s["minY"] - st["minY"]
                    sh_axis = dx_align if axis == "x" else dy_align
                    ortho_shift = dy_align if axis == "x" else dx_align
                    if abs(sh_axis) > 0.15 + FLOAT_CMP_EPS or abs(ortho_shift) <= 10.0:
                        continue
                    if d_o * ortho_shift <= 0.0:
                        continue
                    has_ortho_boxes = box_pk is not None and box_pk[o_lo_idx] is not None and box_pk[o_hi_idx] is not None
                    eff_u_step = u_step
                    if eff_u_step is None and target_ov_mb is not None and has_ortho_boxes:
                        ortho_span_pk = box_pk[o_hi_idx] - box_pk[o_lo_idx]
                        ortho_span_qk = box_qk[o_hi_idx] - box_qk[o_lo_idx]
                        if abs(ortho_span_pk - ortho_span_qk) <= 1.0:
                            eff_u_step = ortho_span_pk - target_ov_mb
                    if eff_u_step is not None and eff_u_step > 10.0:
                        if abs(abs(ortho_shift) - eff_u_step) > 1.0:
                            continue
                    if has_ortho_boxes:
                        ortho_span_pk = box_pk[o_hi_idx] - box_pk[o_lo_idx]
                        ortho_span_qk = box_qk[o_hi_idx] - box_qk[o_lo_idx]
                        imp_ov_mb = (
                            (box_pk[o_hi_idx] - box_qk[o_lo_idx]) if d_o > 0 else (box_qk[o_hi_idx] - box_pk[o_lo_idx])
                        ) - abs(ortho_shift)
                        if imp_ov_mb < -1.0 or imp_ov_mb > ov_tol_mb:
                            continue
                        if target_ov_mb is not None and abs(imp_ov_mb - target_ov_mb) > 1.0:
                            continue
                        if eff_u_step is None and abs(ortho_shift) < 0.55 * min(ortho_span_pk, ortho_span_qk) - 1.0:
                            continue
                    st_pts = st.get("points") or []
                    if not st_pts or shifted_polygon_max_error(s_pts, st_pts, dx_align, dy_align) > 0.1 + FLOAT_CMP_EPS:
                        continue
                    for aux in aux_qk:
                        if (aux[max_k] + sh_axis) < bound_val - 2.2:
                            continue
                        if not _aux_attached_to_piece(aux, st):
                            continue
                        if aux[o_max_k] < box_qk[o_lo_idx] - 2.2 or aux[o_min_k] > box_qk[o_hi_idx] + 2.2:
                            continue
                        shifted_o_min = aux[o_min_k] + ortho_shift
                        shifted_o_max = aux[o_max_k] + ortho_shift
                        if (d_o < 0 and shifted_o_max < 0.0) or (d_o > 0 and shifted_o_min > ortho_dim_pk):
                            return True
            return False

        def _find_margin_clipped_tail_match(
            s: Dict[str, Any],
            pk: int,
            axis: str,
        ) -> Optional[Tuple[int, Dict[str, Any]]]:
            box_cur = box_by_page[pk]
            has_2d_grid = inferred_cols is not None and 2 <= inferred_cols < page_count
            if axis == "x":
                bx_min = box_cur[0] if box_cur[0] is not None else 0.0
                tail_x_min = (bx_min - 25.0) if s.get("dashed") else min(-0.5, bx_min - 2.5)
                can_check_x = (
                    matched_x_any
                    or has_2d_grid
                    or (page_count == 2 and not matched_y_any)
                    or (wrap_kind == "row" and inferred_cols == page_count and not matched_y_any)
                )
                if (
                    s["maxX"] < tail_x_min
                    and not _piece_has_aux_bleed(pk, s, "x", "min", bx_min, grid_cfg=final_grid_cfg)
                    and not _has_mediabox_culled_ortho_tail_aux(pk, s, "x", bx_min)
                ) or not can_check_x:
                    return None
                if wrap_kind == "col" and inferred_cols is not None and inferred_cols >= 2:
                    prev_pk = pk - inferred_cols
                else:
                    if inferred_cols is not None and inferred_cols >= 2 and ((pk - 1) % inferred_cols == 0):
                        return None
                    prev_pk = pk - 1
            else:
                by_min = box_cur[1] if box_cur[1] is not None else 0.0
                tail_y_min = (by_min - 25.0) if s.get("dashed") else min(-0.5, by_min - 2.5)
                can_check_y = (
                    matched_y_any
                    or has_2d_grid
                    or (page_count == 2 and not matched_x_any)
                    or (wrap_kind == "col" and inferred_cols == page_count and not matched_x_any)
                )
                if (
                    s["maxY"] < tail_y_min
                    and not _piece_has_aux_bleed(pk, s, "y", "min", by_min, grid_cfg=final_grid_cfg)
                    and not _has_mediabox_culled_ortho_tail_aux(pk, s, "y", by_min)
                ) or not can_check_y:
                    return None
                if wrap_kind == "col" and inferred_cols is not None and inferred_cols >= 2:
                    if (pk - 1) % inferred_cols == 0:
                        return None
                    prev_pk = pk - 1
                elif inferred_cols is not None and inferred_cols >= 2:
                    prev_pk = pk - inferred_cols
                elif page_count == 2 and not matched_x_any:
                    prev_pk = pk - 1
                else:
                    return None
            if prev_pk not in pieces_by_page or prev_pk < 1:
                return None
            box_prev = box_by_page[prev_pk]
            ubox_prev = unshifted_box_by_page[prev_pk]
            ubox_cur = unshifted_box_by_page[pk]
            pw_prev, ph_prev = get_page_dims_mm(prev_pk)
            page_dim_prev = pw_prev if axis == "x" else ph_prev
            pw_prev_pt, ph_prev_pt = page_dims_pt.get(prev_pk, (page_w_pt, page_h_pt))
            pw_cur_pt, ph_cur_pt = page_dims_pt.get(pk, (page_w_pt, page_h_pt))
            ctm_dx = 0.5 * ((pw_prev_pt - math.ceil(pw_prev_pt)) - (pw_cur_pt - math.ceil(pw_cur_pt))) * pt_to_mm
            ctm_dy = 0.5 * ((ph_prev_pt - math.ceil(ph_prev_pt)) - (ph_cur_pt - math.ceil(ph_cur_pt))) * pt_to_mm
            solids_cur = _get_solids_for_page(pk)
            ov_tol_tail = max(40.0, float(expected_overlap) + 1.0) if expected_overlap is not None else 40.0
            ref_ov = first_overlap_by_axis.get(axis, measured_overlap_mm)
            for s1 in pieces_by_page[prev_pk]:
                if bool(s1.get("dashed")) != bool(s.get("dashed")):
                    continue
                if abs(s1["widthMm"] - s["widthMm"]) > 0.1 + FLOAT_CMP_EPS or abs(s1["heightMm"] - s["heightMm"]) > 0.1 + FLOAT_CMP_EPS:
                    continue
                area_tol_t = max(1.0, 0.01 * max(s1["areaMm2"], s["areaMm2"]))
                if abs(s1["areaMm2"] - s["areaMm2"]) > area_tol_t:
                    continue
                dx_t = (s1["minX"] - s["minX"]) - ctm_dx
                dy_t = (s1["minY"] - s["minY"]) - ctm_dy
                if axis == "x":
                    if dx_t <= 10.0 or abs(dy_t) > 0.1 + FLOAT_CMP_EPS:
                        continue
                    if (
                        "x" in first_step_by_axis
                        and abs(page_dim_prev - first_step_by_axis["x"][1]) <= 0.5
                        and abs(dx_t - first_step_by_axis["x"][0]) > 0.1 + FLOAT_CMP_EPS
                    ):
                        continue
                    if box_cur[0] is not None:
                        if not s.get("dashed"):
                            if (
                                s["maxX"] < box_cur[0] - 2.5
                                and not _piece_has_aux_bleed(pk, s, "x", "min", box_cur[0], grid_cfg=final_grid_cfg)
                                and not _has_mediabox_culled_ortho_tail_aux(pk, s, "x", box_cur[0])
                            ):
                                continue
                        else:
                            if s["maxX"] < box_cur[0] - 25.0:
                                continue
                            enclosing_sols = _get_enclosing_sols(prev_pk, s1)
                            if not enclosing_sols or not any(
                                any(
                                    abs(sol["widthMm"] - s2["widthMm"]) <= 0.1 + FLOAT_CMP_EPS
                                    and abs(sol["heightMm"] - s2["heightMm"]) <= 0.1 + FLOAT_CMP_EPS
                                    and abs((sol["minX"] - s2["minX"]) - ctm_dx - dx_t) <= 0.1 + FLOAT_CMP_EPS
                                    and abs((sol["minY"] - s2["minY"]) - ctm_dy - dy_t) <= 0.1 + FLOAT_CMP_EPS
                                    and (
                                        sol["maxX"] >= dx_t + box_cur[0] - 2.5
                                        or _piece_has_aux_bleed(pk, s2, "x", "min", box_cur[0], grid_cfg=final_grid_cfg)
                                        or _has_mediabox_culled_ortho_tail_aux(pk, s2, "x", box_cur[0])
                                    )
                                    and shifted_polygon_max_error(
                                        sol["points"], s2["points"], sol["minX"] - s2["minX"], sol["minY"] - s2["minY"]
                                    ) <= 0.1 + FLOAT_CMP_EPS
                                    for s2 in solids_cur
                                )
                                for sol in enclosing_sols
                            ):
                                continue
                    if box_prev[2] is not None and s1["maxX"] < box_prev[2] - ov_tol_tail:
                        continue
                    if box_prev[2] is not None and box_cur[0] is not None:
                        imp_ov = (ubox_prev[2] - ubox_cur[0]) - dx_t
                        if imp_ov < -0.1 - FLOAT_CMP_EPS or imp_ov > ov_tol_tail:
                            continue
                        if expected_overlap is not None and abs(imp_ov - float(expected_overlap)) > 0.1 + FLOAT_CMP_EPS:
                            continue
                        if ref_ov is not None and abs(imp_ov - ref_ov) > 0.1 + FLOAT_CMP_EPS:
                            continue
                else:
                    if dy_t <= 10.0 or abs(dx_t) > 0.1 + FLOAT_CMP_EPS:
                        continue
                    if (
                        "y" in first_step_by_axis
                        and abs(page_dim_prev - first_step_by_axis["y"][1]) <= 0.5
                        and abs(dy_t - first_step_by_axis["y"][0]) > 0.1 + FLOAT_CMP_EPS
                    ):
                        continue
                    if box_cur[1] is not None:
                        if not s.get("dashed"):
                            if (
                                s["maxY"] < box_cur[1] - 2.5
                                and not _piece_has_aux_bleed(pk, s, "y", "min", box_cur[1], grid_cfg=final_grid_cfg)
                                and not _has_mediabox_culled_ortho_tail_aux(pk, s, "y", box_cur[1])
                            ):
                                continue
                        else:
                            if s["maxY"] < box_cur[1] - 25.0:
                                continue
                            enclosing_sols = _get_enclosing_sols(prev_pk, s1)
                            if not enclosing_sols or not any(
                                any(
                                    abs(sol["widthMm"] - s2["widthMm"]) <= 0.1 + FLOAT_CMP_EPS
                                    and abs(sol["heightMm"] - s2["heightMm"]) <= 0.1 + FLOAT_CMP_EPS
                                    and abs((sol["minX"] - s2["minX"]) - ctm_dx - dx_t) <= 0.1 + FLOAT_CMP_EPS
                                    and abs((sol["minY"] - s2["minY"]) - ctm_dy - dy_t) <= 0.1 + FLOAT_CMP_EPS
                                    and (
                                        sol["maxY"] >= dy_t + box_cur[1] - 2.5
                                        or _piece_has_aux_bleed(pk, s2, "y", "min", box_cur[1], grid_cfg=final_grid_cfg)
                                        or _has_mediabox_culled_ortho_tail_aux(pk, s2, "y", box_cur[1])
                                    )
                                    and shifted_polygon_max_error(
                                        sol["points"], s2["points"], sol["minX"] - s2["minX"], sol["minY"] - s2["minY"]
                                    ) <= 0.1 + FLOAT_CMP_EPS
                                    for s2 in solids_cur
                                )
                                for sol in enclosing_sols
                            ):
                                continue
                    if box_prev[3] is not None and s1["maxY"] < box_prev[3] - ov_tol_tail:
                        continue
                    if box_prev[3] is not None and box_cur[1] is not None:
                        imp_ov = (ubox_prev[3] - ubox_cur[1]) - dy_t
                        if imp_ov < -0.1 - FLOAT_CMP_EPS or imp_ov > ov_tol_tail:
                            continue
                        if expected_overlap is not None and abs(imp_ov - float(expected_overlap)) > 0.1 + FLOAT_CMP_EPS:
                            continue
                        if ref_ov is not None and abs(imp_ov - ref_ov) > 0.1 + FLOAT_CMP_EPS:
                            continue
                if shifted_polygon_max_error(s1["points"], s["points"], s1["minX"] - s["minX"], s1["minY"] - s["minY"]) <= 0.1 + FLOAT_CMP_EPS:
                    return prev_pk, s1
            return None

        def _has_margin_clipped_tail_match(s: Dict[str, Any], pk: int, axis: str) -> bool:
            nonlocal matched_any_pair, matched_x_any, matched_y_any
            nonlocal tile_step_mm, measured_overlap_mm, tile_parity_max_err_mm
            res = _find_margin_clipped_tail_match(s, pk, axis)
            if res is None:
                return False
            prev_pk, s1 = res
            uf_union((prev_pk, id(s1)), (pk, id(s)))
            pw_prev_pt, ph_prev_pt = page_dims_pt.get(prev_pk, (page_w_pt, page_h_pt))
            pw_cur_pt, ph_cur_pt = page_dims_pt.get(pk, (page_w_pt, page_h_pt))
            ctm_dx = 0.5 * ((pw_prev_pt - math.ceil(pw_prev_pt)) - (pw_cur_pt - math.ceil(pw_cur_pt))) * pt_to_mm
            ctm_dy = 0.5 * ((ph_prev_pt - math.ceil(ph_prev_pt)) - (ph_cur_pt - math.ceil(ph_cur_pt))) * pt_to_mm
            step_t = ((s1["minX"] - s["minX"]) - ctm_dx) if axis == "x" else ((s1["minY"] - s["minY"]) - ctm_dy)
            box_prev = box_by_page[prev_pk]
            ubox_prev = unshifted_box_by_page[prev_pk]
            ubox_cur = unshifted_box_by_page[pk]
            box_cur = box_by_page[pk]
            hi_idx, lo_idx = (2, 0) if axis == "x" else (3, 1)
            pw_prev, ph_prev = get_page_dims_mm(prev_pk)
            page_dim_prev = pw_prev if axis == "x" else ph_prev
            matched_any_pair = True
            if axis == "x":
                matched_x_any = True
                matched_s1_x[prev_pk].add(id(s1))
                matched_s2_x[pk].add(id(s))
            else:
                matched_y_any = True
                matched_s1_y[prev_pk].add(id(s1))
                matched_s2_y[pk].add(id(s))
            if tile_step_mm is None:
                tile_step_mm = step_t
            if axis not in first_step_by_axis:
                first_step_by_axis[axis] = (step_t, page_dim_prev)
            if box_prev[hi_idx] is not None and box_cur[lo_idx] is not None:
                imp_ov = (ubox_prev[hi_idx] - ubox_cur[lo_idx]) - step_t
                if measured_overlap_mm is None:
                    measured_overlap_mm = imp_ov
                if axis not in first_overlap_by_axis:
                    first_overlap_by_axis[axis] = imp_ov
            poly_err_t = shifted_polygon_max_error(s1["points"], s["points"], s1["minX"] - s["minX"], s1["minY"] - s["minY"])
            if tile_parity_max_err_mm is None or poly_err_t > tile_parity_max_err_mm:
                tile_parity_max_err_mm = poly_err_t
            return True

        def is_first_pos_on_axis(pk: int, axis: str) -> bool:
            if axis == "x":
                if not matched_x_any:
                    return True
                if page_count == 2:
                    return pk == 1
                if page_count >= 3 and inferred_cols is not None and wrap_kind in ("row", "col"):
                    return ((pk - 1) % inferred_cols == 0) if wrap_kind == "row" else (pk <= inferred_cols)
                return pk == 1
            if not matched_y_any:
                return True
            if page_count == 2:
                return pk == 1
            if page_count >= 3 and inferred_cols is not None and wrap_kind in ("row", "col"):
                return (pk <= inferred_cols) if wrap_kind == "row" else ((pk - 1) % inferred_cols == 0)
            return pk == 1

        def is_final_pos_on_axis(pk: int, axis: str) -> bool:
            if axis == "x":
                if not matched_x_any:
                    return True
                if page_count == 2:
                    return pk == 2
                if page_count >= 3 and inferred_cols is not None and wrap_kind in ("row", "col"):
                    return (pk % inferred_cols == 0) if wrap_kind == "row" else (pk > page_count - inferred_cols)
                return pk == page_count
            if not matched_y_any:
                return True
            if page_count == 2:
                return pk == 2
            if page_count >= 3 and inferred_cols is not None and wrap_kind in ("row", "col"):
                return (pk > page_count - inferred_cols) if wrap_kind == "row" else (pk % inferred_cols == 0)
            return pk == page_count

        def is_final_exempt(s: Dict[str, Any], pk: int, axis: str, side: str, is_final_override: Optional[bool] = None) -> bool:
            is_fst = is_first_pos_on_axis(pk, axis)
            is_fin = is_final_pos_on_axis(pk, axis) if is_final_override is None else is_final_override
            if axis == "x":
                return is_piece_inset_exempt_on_axis(
                    s, pk, "x", side, is_fst, is_fin, matched_x_any,
                    matched_s1_x[pk], matched_s2_x[pk], matched_s1_y[pk] | matched_s2_y[pk],
                )
            return is_piece_inset_exempt_on_axis(
                s, pk, "y", side, is_fst, is_fin, matched_y_any,
                matched_s1_y[pk], matched_s2_y[pk], matched_s1_x[pk] | matched_s2_x[pk],
            )

        for p_a, p_b, p_ax, matched_s1_ids in pair_overflow_records:
            obox_a = overflow_box_by_page[p_a]
            pieces_a = pieces_by_page[p_a]
            if p_ax == "x":
                unmatched_overflow = [
                    s for s in pieces_a
                    if s["maxX"] > obox_a[2] + 1.0
                    and id(s) not in matched_s1_ids
                    and not is_final_exempt(s, p_a, "x", "max", is_final_override=False)
                ]
            elif p_ax == "y":
                unmatched_overflow = [
                    s for s in pieces_a
                    if s["maxY"] > obox_a[3] + 1.0
                    and id(s) not in matched_s1_ids
                    and not is_final_exempt(s, p_a, "y", "max", is_final_override=False)
                ]
            else:
                unmatched_overflow = [
                    s for s in pieces_a
                    if id(s) not in matched_s1_ids
                    and (
                        (s["maxX"] > obox_a[2] + 1.0 and not is_final_exempt(s, p_a, "x", "max", is_final_override=False))
                        or (s["maxY"] > obox_a[3] + 1.0 and not is_final_exempt(s, p_a, "y", "max", is_final_override=False))
                    )
                ]
            if unmatched_overflow:
                if p_a == 1:
                    emitted_p1_overflow = True
                errors.append(
                    f"E08 Page {p_a} contains {len(unmatched_overflow)} piece(s) overflowing printable tile bounds without a matching shifted continuation on page {p_b}"
                )

        # Ensure NO piece overflows left (minX) or top (minY) tile bounds without an active continuation match
        for pk in checked_keys:
            obox_pk = overflow_box_by_page[pk]
            if obox_pk[0] is not None and obox_pk[1] is not None:
                unmatched_left = [
                    s for s in pieces_by_page[pk]
                    if s["minX"] < obox_pk[0] - 1.0
                    and id(s) not in matched_s2_x[pk]
                    and not (s["maxX"] < obox_pk[0] - 1.0 and _has_margin_clipped_tail_match(s, pk, "x"))
                    and not is_final_exempt(s, pk, "x", "min")
                ]
                unmatched_top = [
                    s for s in pieces_by_page[pk]
                    if s["minY"] < obox_pk[1] - 1.0
                    and id(s) not in matched_s2_y[pk]
                    and not (s["maxY"] < obox_pk[1] - 1.0 and _has_margin_clipped_tail_match(s, pk, "y"))
                    and not is_final_exempt(s, pk, "y", "min")
                ]
                if unmatched_left:
                    if pk == 1:
                        emitted_p1_overflow = True
                    errors.append(
                        f"E08 Page {pk} contains {len(unmatched_left)} piece(s) overflowing left printable tile bounds without a matching continuation"
                    )
                if unmatched_top:
                    if pk == 1:
                        emitted_p1_overflow = True
                    errors.append(
                        f"E08 Page {pk} contains {len(unmatched_top)} piece(s) overflowing top printable tile bounds without a matching continuation"
                    )
                for s in pieces_by_page[pk]:
                    if s["minX"] < obox_pk[0] - 1.0 and id(s) not in matched_s2_x[pk]:
                        _has_margin_clipped_tail_match(s, pk, "x")
                    if s["minY"] < obox_pk[1] - 1.0 and id(s) not in matched_s2_y[pk]:
                        _has_margin_clipped_tail_match(s, pk, "y")

        # If 1D (S == page_count) was selected, never accept non-last-page or outer-axis overflows past printable bounds without a matching wrap
        if page_count >= 3 and inferred_cols == page_count and wrap_kind in ("row", "col"):
            allow_inset_1d = measured_overlap_mm is None or measured_overlap_mm >= -0.1 - FLOAT_CMP_EPS
            for pk in checked_keys:
                chk_box_pk = box_by_page[pk]
                if chk_box_pk[0] is None:
                    continue
                if wrap_kind == "row":
                    outer_ov = [
                        s for s in pieces_by_page[pk]
                        if s["maxY"] > chk_box_pk[3] + 1.0
                        and not (allow_inset_1d and is_final_exempt(s, pk, "y", "max", is_final_override=True))
                    ]
                    inner_ov = (
                        [
                            s for s in pieces_by_page[pk]
                            if s["maxX"] > chk_box_pk[2] + 1.0
                            and id(s) not in matched_s1_x[pk]
                            and not (allow_inset_1d and is_final_exempt(s, pk, "x", "max", is_final_override=False))
                        ]
                        if pk < page_count
                        else []
                    )
                else:
                    outer_ov = [
                        s for s in pieces_by_page[pk]
                        if s["maxX"] > chk_box_pk[2] + 1.0
                        and not (allow_inset_1d and is_final_exempt(s, pk, "x", "max", is_final_override=True))
                    ]
                    inner_ov = (
                        [
                            s for s in pieces_by_page[pk]
                            if s["maxY"] > chk_box_pk[3] + 1.0
                            and id(s) not in matched_s1_y[pk]
                            and not (allow_inset_1d and is_final_exempt(s, pk, "y", "max", is_final_override=False))
                        ]
                        if pk < page_count
                        else []
                    )
                if outer_ov or inner_ov:
                    errors.append(
                        f"E08 Page {pk} contains {len(outer_ov) + len(inner_ov)} piece(s) overflowing printable tile bounds without a 2D wrap/continuation"
                    )

        if page_count == 2:
            obox_1 = overflow_box_by_page.get(1)
            if obox_1 is not None and obox_1[2] is not None and obox_1[3] is not None:
                p1_unmatched_right = [
                    s for s in pieces_by_page.get(1, [])
                    if s["maxX"] > obox_1[2] + 1.0
                    and id(s) not in matched_s1_x[1]
                    and not is_final_exempt(s, 1, "x", "max")
                ]
                p1_unmatched_bottom = [
                    s for s in pieces_by_page.get(1, [])
                    if s["maxY"] > obox_1[3] + 1.0
                    and id(s) not in matched_s1_y[1]
                    and not is_final_exempt(s, 1, "y", "max")
                ]
                if not emitted_p1_overflow and (p1_unmatched_right or p1_unmatched_bottom):
                    emitted_p1_overflow = True
                    errors.append(
                        f"E08 Page 1 contains {len(p1_unmatched_right) + len(p1_unmatched_bottom)} piece(s) overflowing printable tile bounds without a matching shifted continuation on page 2"
                    )
            obox_2 = overflow_box_by_page.get(2)
            if obox_2 is not None and obox_2[2] is not None and obox_2[3] is not None:
                p2_right_ov = [
                    s for s in pieces_by_page.get(2, [])
                    if s["maxX"] > obox_2[2] + 1.0
                    and not is_final_exempt(s, 2, "x", "max")
                ]
                p2_bottom_ov = [
                    s for s in pieces_by_page.get(2, [])
                    if s["maxY"] > obox_2[3] + 1.0
                    and not is_final_exempt(s, 2, "y", "max")
                ]
                if p2_right_ov or p2_bottom_ov:
                    errors.append(
                        f"E08 Page 2 contains {len(p2_right_ov) + len(p2_bottom_ov)} piece(s) overflowing printable tile bounds on final page"
                    )

        if page_count >= 3 and inferred_cols is not None and wrap_kind in ("row", "col"):
            inner_ax_b = "x" if wrap_kind == "row" else "y"
            outer_ax_b = "y" if wrap_kind == "row" else "x"
            for pk in checked_keys:
                if pk % inferred_cols == 0:
                    ov_in = [
                        s for s in overflowing_pieces_for_axis(pk, inner_ax_b, box_map=overflow_box_by_page)
                        if not is_final_exempt(s, pk, inner_ax_b, "max", is_final_override=True)
                    ]
                    if ov_in:
                        errors.append(
                            f"E08 Page {pk} contains {len(ov_in)} piece(s) overflowing printable tile bounds on final {'column' if wrap_kind == 'row' else 'row'}"
                        )
                if pk > page_count - inferred_cols:
                    ov_out = [
                        s for s in overflowing_pieces_for_axis(pk, outer_ax_b, box_map=overflow_box_by_page)
                        if not is_final_exempt(s, pk, outer_ax_b, "max", is_final_override=True)
                    ]
                    if ov_out:
                        errors.append(
                            f"E08 Page {pk} contains {len(ov_out)} piece(s) overflowing printable tile bounds on final {'row' if wrap_kind == 'row' else 'column'}"
                        )

        if page_count >= 3 and not matched_y_any:
            y_overflow_pages = []
            for pk in checked_keys:
                box_pk = overflow_box_by_page[pk]
                if box_pk[3] is not None:
                    if any(
                        s["maxY"] > box_pk[3] + 1.0 and not is_final_exempt(s, pk, "y", "max")
                        for s in pieces_by_page[pk]
                    ):
                        y_overflow_pages.append(pk)
            should_fail_no_y = False
            if y_overflow_pages:
                if len(checked_keys) == page_count:
                    should_fail_no_y = True
                elif inferred_cols is not None and any((pk + inferred_cols) in page_shapes_by_num for pk in y_overflow_pages):
                    should_fail_no_y = True
                elif broken_wrap_detected:
                    should_fail_no_y = True
            if should_fail_no_y:
                errors.append(
                    f"E08 Pages {y_overflow_pages} contain pieces overflowing vertical tile bounds across {page_count} pages, but no vertical tile progression found"
                )

        if page_count >= 3 and not matched_x_any:
            x_overflow_pages = []
            for pk in checked_keys:
                box_pk = overflow_box_by_page[pk]
                if box_pk[2] is not None:
                    if any(
                        s["maxX"] > box_pk[2] + 1.0 and not is_final_exempt(s, pk, "x", "max")
                        for s in pieces_by_page[pk]
                    ):
                        x_overflow_pages.append(pk)
            should_fail_no_x = False
            if x_overflow_pages:
                if len(checked_keys) == page_count:
                    should_fail_no_x = True
                elif inferred_cols is not None and any((pk + inferred_cols) in page_shapes_by_num for pk in x_overflow_pages):
                    should_fail_no_x = True
                elif broken_wrap_detected:
                    should_fail_no_x = True
            if should_fail_no_x:
                errors.append(
                    f"E08 Pages {x_overflow_pages} contain pieces overflowing horizontal tile bounds across {page_count} pages, but no horizontal tile progression found"
                )

        if not matched_any_pair:
            any_page_overflow = any(
                shape_overflows_box(s, overflow_box_by_page[pk_ov], tol=1.0)
                for pk_ov in checked_keys
                for s in pieces_by_page[pk_ov]
            )
            box_1 = overflow_box_by_page[1]
            if not emitted_p1_overflow and box_1[2] is not None and box_1[3] is not None:
                p1_pieces = pieces_by_page[1]
                overflows = any(
                    s["maxX"] > box_1[2] + 1.0 or s["maxY"] > box_1[3] + 1.0 or s["minX"] < box_1[0] - 1.0 or s["minY"] < box_1[1] - 1.0
                    for s in p1_pieces
                )
                if overflows:
                    errors.append(
                        "E08 Page 1 contains piece overflowing printable tile bounds, but no matching shifted piece found on adjacent page"
                    )
            if expected_overlap is not None and (any_page_overflow or broken_wrap_detected):
                errors.append(
                    f"E08 cannot verify expected tile overlap {float(expected_overlap):.3f}mm across {page_count} pages: no matching shifted piece pair found across pages"
                )

    p1_excluded_frame = (
        None
        if promoted_optA_frame_p1
        else (info_by_page[1]["frame"] if 1 in info_by_page else None)
    )
    filtered_p1: Optional[List[Dict[str, Any]]] = None
    filtered_multi: Optional[List[Dict[str, Any]]] = None
    shape_page_by_id: Dict[int, int] = {}
    if page_count == 1 or expectations.get("checkPage1PieceBounds", False):
        pw_1, ph_1 = get_page_dims_mm(1)
        filtered_p1 = [
            s for s in page1_shapes
            if not is_unstroked_page_bg(s, pw_1, ph_1) and s is not p1_excluded_frame
        ]
        for s in filtered_p1:
            shape_page_by_id[id(s)] = 1
        check_expected_pieces(filtered_p1, expectations, calib_size, calib_tol, errors)
    if page_count >= 2:
        filtered_multi = []
        seen_uf_roots = set()
        for pk_m in sorted(page_shapes_by_num.keys()):
            pw_m, ph_m = get_page_dims_mm(pk_m)
            excl_m = (
                p1_excluded_frame
                if pk_m == 1
                else (info_by_page[pk_m]["frame"] if pk_m in info_by_page else None)
            )
            for s in page_shapes_by_num[pk_m]:
                if not is_unstroked_page_bg(s, pw_m, ph_m) and s is not excl_m:
                    root_key = uf_find((pk_m, id(s)))
                    if root_key in seen_uf_roots:
                        continue
                    seen_uf_roots.add(root_key)
                    filtered_multi.append(s)
                    shape_page_by_id[id(s)] = pk_m
        if not expectations.get("checkPage1PieceBounds", False):
            check_expected_pieces(filtered_multi, expectations, calib_size, calib_tol, errors)

    check_self_intersection = bool(expectations.get("checkSelfIntersection", True))
    self_intersecting_count = 0
    if check_self_intersection:
        reg_mark_ids = {
            id(rm)
            for inf in info_by_page.values()
            for rm in (inf.get("regMarks") or [])
        }
        self_int_candidates = filtered_multi if (page_count >= 2 and filtered_multi is not None) else (filtered_p1 or [])
        for s_idx, s in enumerate(self_int_candidates):
            pts = s["points"]
            is_near_closed = (
                not s["closed"]
                and len(pts) >= 4
                and math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) <= 0.15 + FLOAT_CMP_EPS
            )
            has_si = (s["closed"] or is_near_closed) and polygon_self_intersects(pts)
            if id(s) in reg_mark_ids and not has_si:
                continue
            if has_si:
                self_intersecting_count += 1
                kind_si = "closed" if s["closed"] else "near-closed"
                errors.append(
                    f"PDF {kind_si} shape[{s_idx}] (w={s['widthMm']:.2f}x{s['heightMm']:.2f}mm) self-intersects"
                )

    raw_curve_shapes = (
        filtered_p1
        if (page_count == 1 or expectations.get("checkPage1PieceBounds", False))
        else filtered_multi
    ) or []
    has_curve_exp = bool(
        expectations.get("bezierSegments")
        or expectations.get("expectedCurvePoints")
        or (all(k in expectations for k in ("p0", "cp1", "cp2")) and ("p1" in expectations or "p3" in expectations))
    )
    if has_curve_exp:
        curve_shapes_adj: List[Dict[str, Any]] = []
        for s in raw_curve_shapes:
            pk_s = shape_page_by_id.get(id(s), 1)
            pw_pt_s, ph_pt_s = page_dims_pt.get(pk_s, (page_w_pt, page_h_pt))
            ctm_x_s = 0.5 * (pw_pt_s - math.ceil(pw_pt_s)) * pt_to_mm
            ctm_y_s = 0.5 * (ph_pt_s - math.ceil(ph_pt_s)) * pt_to_mm
            if abs(ctm_x_s) > 1e-9 or abs(ctm_y_s) > 1e-9:
                s_adj = dict(s)
                s_adj["points"] = [(px - ctm_x_s, py - ctm_y_s) for (px, py) in s["points"]]
                curve_shapes_adj.append(s_adj)
            else:
                curve_shapes_adj.append(s)
    else:
        curve_shapes_adj = raw_curve_shapes
    max_curve_dev = check_curve_fidelity(curve_shapes_adj, expectations, errors)

    metrics = {
        "pageCount": page_count,
        "pageWidthPt": page_w_pt,
        "pageHeightPt": page_h_pt,
        "pageWidthMm": page_w_mm,
        "pageHeightMm": page_h_mm,
        "page1Calib50Count": len(page1_calib_50),
        "regMarksFound": reg_marks_found,
        "dashedFound": dashed_found,
        "internalLineCandidates": len(internal_candidates),
        "hasRealInternalLines": has_real_internal_lines,
        "tileStepMm": tile_step_mm,
        "measuredOverlapMm": measured_overlap_mm,
        "tileParityMaxErrMm": tile_parity_max_err_mm,
        "totalExtractedShapes": len(all_shapes),
        "maxCurveDeviationMm": max_curve_dev,
        "selfIntersectingShapes": self_intersecting_count,
    }
    return errors, metrics


def sample_dxf_bulge_arc(
    p0: Tuple[float, float],
    p1: Tuple[float, float],
    bulge: float,
    steps: Optional[int] = None,
) -> List[Tuple[float, float]]:
    if abs(bulge) < 1e-9:
        return [p1]
    dx = p1[0] - p0[0]
    dy = p1[1] - p0[1]
    chord = math.hypot(dx, dy)
    if chord < 1e-9:
        return [p1]
    theta = 4.0 * math.atan(bulge)
    sin_half = math.sin(theta * 0.5)
    if abs(sin_half) < 1e-9:
        return [p1]
    radius = chord / (2.0 * abs(sin_half))
    if steps is None:
        steps = adaptive_arc_steps(radius, theta, min_steps=16, max_steps=4096)
    sagitta_dir = 1.0 if bulge > 0 else -1.0
    # Distance from midpoint to center along left normal
    h = (chord * 0.5) / math.tan(theta * 0.5)
    mx = 0.5 * (p0[0] + p1[0])
    my = 0.5 * (p0[1] + p1[1])
    nx = -dy / chord
    ny = dx / chord
    cx = mx + nx * h
    cy = my + ny * h
    a0 = math.atan2(p0[1] - cy, p0[0] - cx)
    pts = []
    for i in range(1, steps + 1):
        a = a0 + theta * (i / steps)
        pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return pts


def verify_dxf(file_path: str, expectations: Dict[str, Any]) -> Tuple[List[str], Dict[str, Any]]:
    errors: List[str] = []
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        lines = [ln.rstrip("\r\n") for ln in f.readlines()]

    if len(lines) < 4:
        return ["DXF file too short"], {}

    pairs: List[Tuple[int, str]] = []
    i = 0
    while i + 1 < len(lines):
        code_str = lines[i].strip()
        val_str = lines[i + 1].strip()
        try:
            code = int(code_str)
        except ValueError:
            errors.append(f"Malformed DXF group code at line {i + 1}: {code_str!r}")
            break
        pairs.append((code, val_str))
        i += 2

    has_eof = any(c == 0 and v == "EOF" for c, v in pairs)
    if not has_eof:
        errors.append("DXF missing 0 / EOF marker")

    # Parse sections
    insunits: Optional[int] = None
    tables_layers: List[str] = []
    has_tables_section = False
    has_layer_table = False
    lwpolylines: List[Dict[str, Any]] = []
    polylines: List[Dict[str, Any]] = []
    dxf_lines: List[Dict[str, Any]] = []

    section = None
    idx = 0
    npairs = len(pairs)
    while idx < npairs:
        c, v = pairs[idx]
        if c == 0 and v == "SECTION":
            if idx + 1 < npairs and pairs[idx + 1][0] == 2:
                section = pairs[idx + 1][1].upper()
                if section == "TABLES":
                    has_tables_section = True
                idx += 2
                continue
        elif c == 0 and v == "ENDSEC":
            section = None
            idx += 1
            continue

        if section == "HEADER":
            if c == 9 and v == "$INSUNITS":
                j = idx + 1
                while j < npairs and pairs[j][0] != 9 and pairs[j][0] != 0:
                    if pairs[j][0] == 70:
                        try:
                            insunits = int(pairs[j][1])
                        except ValueError:
                            pass
                        break
                    j += 1
        elif section == "TABLES":
            if c == 0 and v == "TABLE" and idx + 1 < npairs and pairs[idx + 1] == (2, "LAYER"):
                has_layer_table = True
            elif c == 0 and v == "LAYER":
                j = idx + 1
                while j < npairs and pairs[j][0] != 0:
                    if pairs[j][0] == 2:
                        tables_layers.append(pairs[j][1])
                    j += 1
        elif section == "ENTITIES":
            if c == 0 and v == "LWPOLYLINE":
                layer = "0"
                flags = 0
                expected_n: Optional[int] = None
                verts: List[Tuple[float, float, float]] = []
                cur_x: Optional[float] = None
                cur_y: Optional[float] = None
                cur_b: float = 0.0
                j = idx + 1
                while j < npairs and pairs[j][0] != 0:
                    gc, gv = pairs[j]
                    if gc == 8:
                        layer = gv
                    elif gc == 70:
                        flags = int(float(gv))
                    elif gc == 90:
                        expected_n = int(float(gv))
                    elif gc == 10:
                        if cur_x is not None and cur_y is not None:
                            verts.append((cur_x, cur_y, cur_b))
                            cur_b = 0.0
                        cur_x = float(gv)
                        cur_y = None
                    elif gc == 20:
                        cur_y = float(gv)
                    elif gc == 42:
                        cur_b = float(gv)
                    j += 1
                if cur_x is not None and cur_y is not None:
                    verts.append((cur_x, cur_y, cur_b))

                if expected_n is not None and len(verts) != expected_n:
                    errors.append(f"DXF LWPOLYLINE group 90={expected_n} != actual vertices={len(verts)}")

                closed = bool(flags & 1)
                sampled: List[Tuple[float, float]] = []
                if verts:
                    sampled.append((verts[0][0], verts[0][1]))
                    for k in range(len(verts)):
                        if k + 1 < len(verts):
                            nx, ny, _ = verts[k + 1]
                            bulge = verts[k][2]
                            sampled.extend(sample_dxf_bulge_arc((verts[k][0], verts[k][1]), (nx, ny), bulge))
                        elif closed and len(verts) >= 2:
                            bulge = verts[k][2]
                            if abs(bulge) > 1e-9:
                                sampled.extend(sample_dxf_bulge_arc((verts[k][0], verts[k][1]), (verts[0][0], verts[0][1]), bulge))
                m = polygon_metrics(sampled, closed)
                m["layer"] = layer
                m["entity"] = "LWPOLYLINE"
                m["flags"] = flags
                m["dashed"] = False
                lwpolylines.append(m)
                idx = j
                continue
            elif c == 0 and v == "POLYLINE":
                layer = "0"
                flags = 0
                verts_xyb: List[Tuple[float, float, float]] = []
                j = idx + 1
                while j < npairs and pairs[j][0] != 0:
                    if pairs[j][0] == 8:
                        layer = pairs[j][1]
                    elif pairs[j][0] == 70:
                        flags = int(float(pairs[j][1]))
                    j += 1
                while j < npairs and not (pairs[j][0] == 0 and pairs[j][1] == "SEQEND"):
                    if pairs[j][0] == 0 and pairs[j][1] == "VERTEX":
                        vx = vy = None
                        vb = 0.0
                        k = j + 1
                        while k < npairs and pairs[k][0] != 0:
                            if pairs[k][0] == 10:
                                vx = float(pairs[k][1])
                            elif pairs[k][0] == 20:
                                vy = float(pairs[k][1])
                            elif pairs[k][0] == 42:
                                vb = float(pairs[k][1])
                            k += 1
                        if vx is not None and vy is not None:
                            verts_xyb.append((vx, vy, vb))
                        j = k
                        continue
                    j += 1
                p_closed = bool(flags & 1)
                sampled_poly: List[Tuple[float, float]] = []
                if verts_xyb:
                    sampled_poly.append((verts_xyb[0][0], verts_xyb[0][1]))
                    for k in range(len(verts_xyb)):
                        if k + 1 < len(verts_xyb):
                            nx, ny, _ = verts_xyb[k + 1]
                            bulge = verts_xyb[k][2]
                            sampled_poly.extend(sample_dxf_bulge_arc((verts_xyb[k][0], verts_xyb[k][1]), (nx, ny), bulge))
                        elif p_closed and len(verts_xyb) >= 2:
                            bulge = verts_xyb[k][2]
                            if abs(bulge) > 1e-9:
                                sampled_poly.extend(sample_dxf_bulge_arc((verts_xyb[k][0], verts_xyb[k][1]), (verts_xyb[0][0], verts_xyb[0][1]), bulge))
                m = polygon_metrics(sampled_poly, p_closed)
                m["layer"] = layer
                m["entity"] = "POLYLINE"
                m["dashed"] = False
                polylines.append(m)
                idx = j
                continue
            elif c == 0 and v == "LINE":
                x1 = y1 = x2 = y2 = 0.0
                layer = "0"
                j = idx + 1
                while j < npairs and pairs[j][0] != 0:
                    gc, gv = pairs[j]
                    if gc == 8: layer = gv
                    elif gc == 10: x1 = float(gv)
                    elif gc == 20: y1 = float(gv)
                    elif gc == 11: x2 = float(gv)
                    elif gc == 21: y2 = float(gv)
                    j += 1
                m = polygon_metrics([(x1, y1), (x2, y2)], False)
                m["layer"] = layer
                m["entity"] = "LINE"
                m["dashed"] = False
                dxf_lines.append(m)
                idx = j
                continue
        idx += 1

    if expectations.get("requireInsUnits4", True) and insunits != 4:
        errors.append(f"DXF $INSUNITS must be 4 (millimeters), got {insunits}")

    if expectations.get("requireTablesLayer", True):
        if not has_tables_section or not has_layer_table or len(tables_layers) < 1:
            errors.append(
                f"DXF must define TABLES/LAYER with >=1 layer (hasTables={has_tables_section}, hasLayerTable={has_layer_table}, layers={tables_layers})"
            )

    for lyr in expectations.get("expectedLayers") or []:
        if not any(str(lyr).lower() == t.lower() or str(lyr).lower() in t.lower() for t in tables_layers):
            errors.append(f"Expected DXF layer '{lyr}' not found in TABLES/LAYER {tables_layers}")

    all_polys = lwpolylines + polylines
    closed_lw = [p for p in lwpolylines if p["closed"]]
    if expectations.get("requireClosedLwpolyline", True) and len(closed_lw) == 0:
        errors.append("DXF contains no closed LWPOLYLINE (group 70 & 1) entities")

    check_self_intersection = expectations.get("checkSelfIntersection", True)
    self_intersecting_count = 0
    if check_self_intersection:
        for p_idx, p in enumerate(all_polys):
            pts = p["points"]
            is_near_closed = (
                not p["closed"]
                and len(pts) >= 4
                and math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) <= 0.15 + FLOAT_CMP_EPS
            )
            if (p["closed"] or is_near_closed) and polygon_self_intersects(pts):
                self_intersecting_count += 1
                kind = "closed" if p["closed"] else "near-closed"
                errors.append(
                    f"DXF {kind} {p['entity']}[{p_idx}] (layer={p.get('layer') or '0'}, w={p['widthMm']:.2f}x{p['heightMm']:.2f}mm) self-intersects"
                )

    calib_size = float(expectations.get("calibSizeMm", 50.0))
    calib_tol = float(expectations.get("calibTolMm", 0.1))
    calib_candidates = [p for p in all_polys if is_square_of_size(p, calib_size, calib_tol)]
    if expectations.get("requireCalibrationSquare", True) and not calib_candidates:
        errors.append(f"Missing {calib_size} ± {calib_tol} mm closed calibration square LWPOLYLINE in DXF")

    cut_layer_polys = [p for p in all_polys if is_cut_layer_name(p.get("layer"))]
    unclosed_cut_polys = [p for p in cut_layer_polys if not p["closed"]]
    if unclosed_cut_polys:
        errors.append(
            f"DXF CUT layer contains {len(unclosed_cut_polys)} unclosed {unclosed_cut_polys[0]['entity']} entity (w={unclosed_cut_polys[0]['widthMm']:.2f}x{unclosed_cut_polys[0]['heightMm']:.2f}mm)"
        )
    cut_layer_lines = [ln for ln in dxf_lines if is_cut_layer_name(ln.get("layer"))]
    if cut_layer_lines:
        errors.append(f"DXF CUT layer contains {len(cut_layer_lines)} LINE entities (expected closed LWPOLYLINE)")
    cut_layer_closed = [p for p in cut_layer_polys if p["closed"]]
    seam_layer_closed = [p for p in all_polys if p["closed"] and is_seam_layer_name(p.get("layer"))]
    if seam_layer_closed and not cut_layer_closed:
        errors.append("DXF has closed SEAM polylines but no closed CUT polylines")
    elif seam_layer_closed:
        for us in find_unmatched_seam_contours(seam_layer_closed, cut_layer_closed, tol=0.25):
            errors.append(
                f"DXF closed SEAM polyline (w={us['widthMm']:.2f}x{us['heightMm']:.2f}mm) has no matching enclosing closed CUT polyline"
            )

    check_expected_pieces(all_polys, expectations, calib_size, calib_tol, errors, check_cut_duplicates=True)
    max_curve_dev = check_curve_fidelity(all_polys + dxf_lines, expectations, errors)

    metrics = {
        "insunits": insunits,
        "hasTablesSection": has_tables_section,
        "hasLayerTable": has_layer_table,
        "layers": tables_layers,
        "lwpolylineCount": len(lwpolylines),
        "closedLwpolylineCount": len(closed_lw),
        "polylineCount": len(polylines),
        "lineCount": len(dxf_lines),
        "calib50Count": len(calib_candidates),
        "maxCurveDeviationMm": max_curve_dev,
        "selfIntersectingShapes": self_intersecting_count,
    }
    return errors, metrics


def main() -> int:
    parser = argparse.ArgumentParser(description="Independent 1:1 export verifier")
    parser.add_argument("--format", required=True, choices=["svg", "pdf", "dxf"])
    parser.add_argument("--file", required=True)
    parser.add_argument("--expectations", default=None)
    args = parser.parse_args()

    expectations: Dict[str, Any] = {}
    if args.expectations:
        with open(args.expectations, "r", encoding="utf-8") as f:
            expectations = json.load(f)

    if not os.path.exists(args.file):
        out = {"ok": False, "errors": [f"File not found: {args.file}"], "metrics": {}}
        print(json.dumps(out))
        return 1

    if args.format == "svg":
        errors, metrics = verify_svg(args.file, expectations)
    elif args.format == "pdf":
        errors, metrics = verify_pdf(args.file, expectations)
    else:
        errors, metrics = verify_dxf(args.file, expectations)

    out = {"ok": len(errors) == 0, "errors": errors, "metrics": metrics}
    print(json.dumps(out))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
