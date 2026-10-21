# Ocean HF download-client patch, urllib variant, loaded via PYTHONPATH=<this dir> (read-only
# mount)
import os
import sys
import threading

_ocean_stats = {"swapped": False, "skip": None, "files": 0, "bytes": 0, "retries": 0,
                "fallback": 0, "fallback_reasons": {}}
_ocean_lock = threading.Lock()
_ocean_ssl = []

_HTTP_GET_PARAMS = ("url", "temp_file", "resume_size", "headers", "expected_size",
                    "displayed_filename", "tqdm_class", "_nb_retries", "_tqdm_bar")
_BUF = 1 << 20
_PROGRESS_EVERY = 16 << 20


def _ocean_chain_shadowed_sitecustomize():
    import importlib.util
    from importlib.machinery import PathFinder
    here = os.path.dirname(os.path.abspath(__file__))
    rest = [p for p in sys.path if os.path.abspath(p or ".") != here]
    spec = PathFinder.find_spec("sitecustomize", rest)
    if spec and spec.loader and spec.origin and os.path.abspath(spec.origin) != os.path.abspath(__file__):
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)


def _ocean_count(key, n=1):
    with _ocean_lock:
        _ocean_stats[key] += n


def _ocean_fallback(reason):
    with _ocean_lock:
        _ocean_stats["fallback"] += 1
        reasons = _ocean_stats["fallback_reasons"]
        reasons[reason] = reasons.get(reason, 0) + 1
    if os.environ.get("OCEAN_HFPATCH_DEBUG") == "1":
        print("[ocean-hfpatch] pid=%d fallback to stock http_get: %s" % (os.getpid(), reason), file=sys.stderr)


def _ocean_ssl_context():
    with _ocean_lock:
        if not _ocean_ssl:
            import ssl
            cafile = os.environ.get("SSL_CERT_FILE") or None
            if cafile is None:
                try:
                    import certifi
                    cafile = certifi.where()
                except Exception:
                    cafile = None
            _ocean_ssl.append(ssl.create_default_context(cafile=cafile))
        return _ocean_ssl[0]


def _ocean_swap_http_get(fd, debug):
    import inspect
    orig = fd.http_get
    if getattr(orig, "_ocean_urllib", False):
        return
    try:
        params = tuple(inspect.signature(orig).parameters)
    except (TypeError, ValueError):
        params = ()
    missing = [n for n in ("constants", "logger", "_get_progress_bar_context") if not hasattr(fd, n)]
    if params != _HTTP_GET_PARAMS or missing:
        _ocean_stats["skip"] = "unknown http_get shape: %s %s" % (",".join(params), ",".join(missing))
        if debug:
            print("[ocean-hfpatch] http_get left stock: " + _ocean_stats["skip"], file=sys.stderr)
        return

    import http.client
    import urllib.error
    import urllib.request
    from contextlib import ExitStack
    const = fd.constants
    local = threading.local()

    def stock(url, temp_file, **kwargs):
        local.depth = getattr(local, "depth", 0) + 1
        try:
            return orig(url, temp_file, **kwargs)
        finally:
            local.depth -= 1

    def http_get(url, temp_file, *, resume_size=0, headers=None, expected_size=None,
                 displayed_filename=None, tqdm_class=None, _nb_retries=5, _tqdm_bar=None):
        kwargs = dict(resume_size=resume_size, headers=headers, expected_size=expected_size,
                      displayed_filename=displayed_filename, tqdm_class=tqdm_class,
                      _nb_retries=_nb_retries, _tqdm_bar=_tqdm_bar)
        if getattr(local, "depth", 0):
            return orig(url, temp_file, **kwargs)
        if expected_size is not None and resume_size == expected_size:
            return None
        if any(k.lower() == "range" for k in (headers or {})):
            _ocean_fallback("caller Range header")
            return stock(url, temp_file, **kwargs)
        if not resume_size and expected_size and expected_size > const.MAX_HTTP_DOWNLOAD_SIZE:
            _ocean_fallback("over MAX_HTTP_DOWNLOAD_SIZE")
            return stock(url, temp_file, **kwargs)

        auth, plain = None, {}
        for k, v in (headers or {}).items():
            if k.lower() == "authorization":
                auth = v
            elif k.lower() != "accept-encoding":
                plain[k] = v
        plain["Accept-Encoding"] = "identity"
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_ocean_ssl_context()))
        base = temp_file.tell() - resume_size
        done = resume_size
        retries = _nb_retries
        bar = None
        pending = [0]

        def flush():
            if bar is not None and pending[0]:
                bar.update(pending[0])
                transfer = getattr(bar, "update_transfer", None)
                if callable(transfer):
                    transfer(pending[0])
            pending[0] = 0

        def handover(reason):
            flush()
            _ocean_fallback(reason)
            return stock(url, temp_file, resume_size=done, headers=headers,
                         expected_size=expected_size, displayed_filename=displayed_filename,
                         tqdm_class=tqdm_class, _nb_retries=retries,
                         _tqdm_bar=bar if bar is not None else _tqdm_bar)

        with ExitStack() as stack:
            while True:
                req = urllib.request.Request(url, headers=plain)
                if done:
                    req.add_header("Range", "bytes=%d-" % done)
                if auth is not None:
                    req.add_unredirected_header("Authorization", auth)
                err = None
                try:
                    resp = opener.open(req, timeout=const.HF_HUB_DOWNLOAD_TIMEOUT)
                except urllib.error.HTTPError as e:
                    e.close()
                    return handover("HTTP %d" % e.code)
                except (OSError, http.client.HTTPException) as e:
                    resp, err = None, e
                got = 0
                if resp is not None:
                    with resp:
                        enc = (resp.headers.get("Content-Encoding") or "identity").lower()
                        if enc != "identity":
                            return handover("Content-Encoding " + enc)
                        if resp.status == 200 and done:
                            flush()
                            temp_file.seek(base)
                            temp_file.truncate()
                            if bar is not None:
                                bar.update(-done)
                                transfer = getattr(bar, "update_transfer", None)
                                if callable(transfer):
                                    transfer(-done)
                            done = 0
                        elif resp.status == 206:
                            cr = resp.headers.get("Content-Range") or ""
                            if not done or not cr.startswith("bytes %d-" % done):
                                return handover("unexpected Content-Range")
                        elif resp.status != 200:
                            return handover("HTTP %d" % resp.status)
                        if bar is None:
                            total = expected_size
                            if total is None:
                                cl = resp.headers.get("Content-Length")
                                total = done + int(cl) if cl and cl.isdigit() else None
                            name = displayed_filename or url
                            if len(name) > 40:
                                name = "(…)" + name[-40:]
                            bar = stack.enter_context(fd._get_progress_bar_context(
                                desc=name, log_level=fd.logger.getEffectiveLevel(), total=total,
                                initial=done, name="huggingface_hub.http_get",
                                tqdm_class=tqdm_class, _tqdm_bar=_tqdm_bar))
                        buf = bytearray(_BUF)
                        view = memoryview(buf)
                        while True:
                            try:
                                n = resp.readinto(buf)
                            except (OSError, http.client.HTTPException) as e:
                                err = e
                                break
                            if not n:
                                break
                            temp_file.write(view[:n])
                            done += n
                            got += n
                            pending[0] += n
                            if pending[0] >= _PROGRESS_EVERY:
                                flush()
                        flush()
                        if err is None and resp.length:
                            err = http.client.IncompleteRead(b"", resp.length)
                if err is None:
                    break
                if got:
                    retries = 5
                if retries <= 0:
                    fd.logger.warning("Error while downloading from %s: %s\nMax retries exceeded.", url, err)
                    raise err
                fd.logger.warning("Error while downloading from %s: %s\nTrying to resume download...", url, err)
                _ocean_count("retries")
                retries -= 1
                import time
                time.sleep(1)

        if expected_size is not None and expected_size != done:
            raise OSError(
                "Consistency check failed: file should be of size %d but has size %d (%s).\n"
                "This is usually due to network issues while downloading the file. Please retry "
                "with `force_download=True`." % (expected_size, done, displayed_filename or url))
        _ocean_count("files")
        _ocean_count("bytes", done - resume_size)
        if debug:
            print("[ocean-hfpatch] urllib file bytes=%d pid=%d" % (done - resume_size, os.getpid()), file=sys.stderr)
        return None

    http_get._ocean_urllib = True
    http_get.__wrapped__ = orig
    fd.http_get = http_get
    hfs = sys.modules.get("huggingface_hub.hf_file_system")
    if hfs is not None and getattr(hfs, "http_get", None) is orig:
        hfs.http_get = http_get
    _ocean_stats["swapped"] = True
    if debug:
        print("[ocean-hfpatch] pid=%d http_get -> urllib" % os.getpid(), file=sys.stderr)


def _ocean_install():
    read_bytes = int(os.environ.get("OCEAN_HFPATCH_READ_BYTES", str(1 << 20)))
    debug = os.environ.get("OCEAN_HFPATCH_DEBUG") == "1"
    swap = os.environ.get("OCEAN_HFPATCH_URLLIB", "1") != "0"

    def _set_read(mod):
        mod.HTTP11Connection.READ_NUM_BYTES = read_bytes

    def _set_chunk(mod):
        mod.DOWNLOAD_CHUNK_SIZE = None

    def _set_http_get(mod):
        if swap:
            _ocean_swap_http_get(mod, debug)

    targets = {
        "httpcore._sync.http11": _set_read,
        "httpcore2._sync.http11": _set_read,
        "huggingface_hub.constants": _set_chunk,
        "huggingface_hub.file_download": _set_http_get,
    }

    import importlib.abc

    class _Finder(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path, target=None):
            fn = targets.get(name)
            if fn is None:
                return None
            for finder in sys.meta_path:
                if finder is self:
                    continue
                spec = getattr(finder, "find_spec", lambda *a: None)(name, path, target)
                if spec is not None:
                    break
            else:
                return None
            loader = spec.loader
            orig = loader.exec_module

            def exec_module(module, _orig=orig, _fn=fn, _name=name):
                _orig(module)
                try:
                    _fn(module)
                    if debug:
                        print(f"[ocean-hfpatch] pid={os.getpid()} patched {_name}", file=sys.stderr)
                except Exception as e:
                    if debug:
                        print(f"[ocean-hfpatch] {_name}: {e!r}", file=sys.stderr)

            loader.exec_module = exec_module
            return spec

    sys.meta_path.insert(0, _Finder())
    for name, fn in targets.items():
        if name in sys.modules:
            try:
                fn(sys.modules[name])
            except Exception:
                pass


if os.environ.get("OCEAN_HFPATCH", "1") != "0":
    try:
        _ocean_install()
    except Exception:
        pass
try:
    _ocean_chain_shadowed_sitecustomize()
except Exception as e:
    print(f"[ocean-hfpatch] chained sitecustomize failed: {e!r}", file=sys.stderr)
