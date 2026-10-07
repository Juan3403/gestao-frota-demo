#!/usr/bin/env python
"""Consolida PDFs enviados pelo site e escreve o JSON consolidado no stdout."""
import io
import json
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

RAIZ = Path(__file__).resolve().parent.parent
if str(RAIZ) not in sys.path:
    sys.path.insert(0, str(RAIZ))

from pipeline_rendafixa import consolidar


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Uso: importar_upload.py <dir_extratos> [dir_output]")
    dir_extratos = Path(sys.argv[1]).resolve()
    dir_output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    dados = consolidar.consolidar(dir_extratos=dir_extratos, dir_output=dir_output, gravar_json=bool(dir_output))
    json.dump(dados, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
