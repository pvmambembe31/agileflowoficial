#!/usr/bin/env python3
import os, sys, json, secrets, shutil, tempfile, threading, mimetypes, re, base64, hashlib, hmac
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote, urlparse
from pathlib import Path
from datetime import datetime, timezone

VERSION = "1.2.0-server"
ROOT = Path(os.environ.get("AGILEFLOW_ROOT", "/srv/agileflow"))
WEB = Path(os.environ.get("AGILEFLOW_WEB", "/opt/agileflow/web"))
HOST = os.environ.get("AGILEFLOW_HOST", "0.0.0.0")
PORT = int(os.environ.get("AGILEFLOW_PORT", "43127"))
WORKSPACE = ROOT / "workspace.json"
CONFIG = ROOT / "config.json"
BACKUPS = ROOT / "backups"
PROJECTS = ROOT / "projects"
LOCK = threading.RLock()

for p in (ROOT, BACKUPS, PROJECTS, ROOT/"exports", ROOT/"portfolio-assets", ROOT/"profile"):
    p.mkdir(parents=True, exist_ok=True)

def now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')

def atomic_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name+'.', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp): os.unlink(tmp)
        except Exception: pass

def load_config():
    data = {}
    if CONFIG.exists():
        try:
            data = json.loads(CONFIG.read_text(encoding='utf-8'))
        except Exception:
            data = {}
    if not data.get('token'):
        data['token'] = secrets.token_hex(32)
    data['version'] = VERSION
    data.setdefault('createdAt', now_iso())
    data['mode'] = 'debian-online-server'
    atomic_json(CONFIG, data)
    return data

def verify_password(password, auth):
    try:
        salt = bytes.fromhex(auth['salt'])
        expected = bytes.fromhex(auth['hash'])
        iterations = int(auth.get('iterations', 240000))
        actual = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, iterations)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False

def read_workspace():
    if not WORKSPACE.exists(): return None
    try: return json.loads(WORKSPACE.read_text(encoding='utf-8'))
    except Exception: return None

def workspace_revision():
    if not WORKSPACE.exists(): return None
    return hashlib.sha256(WORKSPACE.read_bytes()).hexdigest()

def safe_slug(value):
    value = str(value or 'project').strip().lower()
    value = re.sub(r'[^a-z0-9_-]+','-', value).strip('-')
    return value or 'project'

def write_json(path, value):
    atomic_json(path, value)

def materialize(state):
    if not isinstance(state, dict): return
    write_json(ROOT/'profile'/'profile.json', state.get('profile', {}))
    desired = set()
    for project in state.get('projects', []) or []:
        if not isinstance(project, dict): continue
        slug = safe_slug(project.get('id') or project.get('name'))
        desired.add(slug)
        pdir = PROJECTS/slug
        pdir.mkdir(parents=True, exist_ok=True)
        summary = {k:v for k,v in project.items() if k not in ('epics','stories','sprints','retrospectives','decisions','impediments','evidence','goals','milestones','risks','caseStudy')}
        write_json(pdir/'project.json', summary)
        write_json(pdir/'backlog'/'epics.json', project.get('epics', []))
        write_json(pdir/'backlog'/'stories.json', project.get('stories', []))
        write_json(pdir/'planning'/'goals.json', project.get('goals', []))
        write_json(pdir/'planning'/'milestones.json', project.get('milestones', []))
        write_json(pdir/'planning'/'risks.json', project.get('risks', []))
        write_json(pdir/'sprints'/'sprints.json', project.get('sprints', []))
        write_json(pdir/'retrospectives'/'retrospectives.json', project.get('retrospectives', []))
        write_json(pdir/'decisions'/'decisions.json', project.get('decisions', []))
        write_json(pdir/'impediments'/'impediments.json', project.get('impediments', []))
        write_json(pdir/'evidence'/'evidence.json', project.get('evidence', []))
        write_json(pdir/'case-study.json', project.get('caseStudy', {}))
    for old in PROJECTS.iterdir():
        if old.is_dir() and old.name not in desired:
            archive = BACKUPS/'removed-projects'/f'{old.name}-{datetime.now().strftime("%Y%m%d-%H%M%S-%f")}'
            archive.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old), str(archive))

def backup_current(force=False):
    if not WORKSPACE.exists(): return None
    BACKUPS.mkdir(parents=True, exist_ok=True)
    if not force:
        existing = sorted(BACKUPS.glob('workspace-*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
        if existing and (datetime.now().timestamp() - existing[0].stat().st_mtime) < 600:
            return existing[0]
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    dest = BACKUPS/f'workspace-{stamp}.json'
    shutil.copy2(WORKSPACE, dest)
    keep = sorted(BACKUPS.glob('workspace-*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in keep[30:]:
        try: old.unlink()
        except Exception: pass
    return dest

CONFIG_DATA = load_config()

class Handler(BaseHTTPRequestHandler):
    server_version = "AgileFlowHomeServer/"+VERSION

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt%args))

    def _json(self, status, obj, challenge=False):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        if challenge:
            self.send_header('WWW-Authenticate','Basic realm="AgileFlow Online", charset="UTF-8"')
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.end_headers(); self.wfile.write(data)

    def _body(self):
        try:
            n=int(self.headers.get('Content-Length','0')); raw=self.rfile.read(n) if n else b'{}'
            return json.loads(raw.decode('utf-8')) if raw else {}
        except Exception: return {}

    def _web_auth(self):
        authcfg = CONFIG_DATA.get('webAuth') or {}
        if not authcfg.get('hash'):
            return False
        header = self.headers.get('Authorization','')
        if not header.startswith('Basic '):
            return False
        try:
            raw = base64.b64decode(header[6:].strip()).decode('utf-8')
            username, password = raw.split(':',1)
        except Exception:
            return False
        return hmac.compare_digest(username, str(authcfg.get('username','agileflow'))) and verify_password(password, authcfg)

    def _challenge(self):
        body = b'AgileFlow Online - autenticacao necessaria.'
        self.send_response(401)
        self.send_header('WWW-Authenticate','Basic realm="AgileFlow Online", charset="UTF-8"')
        self.send_header('Content-Type','text/plain; charset=utf-8')
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers()
        self.wfile.write(body)

    def _api_auth(self):
        token = self.headers.get('X-AgileFlow-Token','')
        if token and hmac.compare_digest(token, CONFIG_DATA['token']):
            return True
        bearer = self.headers.get('Authorization','')
        return bearer.startswith('Bearer ') and hmac.compare_digest(bearer[7:], CONFIG_DATA['token'])

    def _api(self, method):
        if not self._web_auth():
            return self._challenge()
        path=urlparse(self.path).path
        if path == '/api/v1/health' and method=='GET':
            st=WORKSPACE.stat() if WORKSPACE.exists() else None
            return self._json(200, {"platform":"linux/debian13","root":str(ROOT),"service":"AgileFlow Online Server","version":VERSION,"workspaceExists":WORKSPACE.exists(),"workspaceModified":datetime.fromtimestamp(st.st_mtime,timezone.utc).isoformat().replace('+00:00','Z') if st else "","serverMode":True,"onlineReady":True})
        if path == '/api/v1/pair' and method=='POST':
            return self._json(200, {"token":CONFIG_DATA['token'],"serverMode":True,"onlineReady":True})
        if not self._api_auth(): return self._json(401,{"error":"unauthorized"})
        if path == '/api/v1/workspace' and method=='GET':
            with LOCK:
                state=read_workspace()
                if state is None: return self._json(404,{"error":"workspace_not_found"})
                st=WORKSPACE.stat()
                return self._json(200,{"state":state,"savedAt":datetime.fromtimestamp(st.st_mtime,timezone.utc).isoformat().replace('+00:00','Z'),"revision":workspace_revision(),"serverMode":True})
        if path == '/api/v1/workspace' and method=='PUT':
            body=self._body(); state=body.get('state',body)
            if not isinstance(state,dict): return self._json(400,{"error":"invalid_state"})
            with LOCK:
                expected = self.headers.get('If-Match')
                current = workspace_revision()
                if expected and expected != current:
                    return self._json(409,{"error":"workspace_changed","revision":current})
                backup_current(True)
                atomic_json(WORKSPACE,state); materialize(state)
                revision = workspace_revision()
                saved_at = datetime.fromtimestamp(WORKSPACE.stat().st_mtime,timezone.utc).isoformat().replace('+00:00','Z')
            return self._json(200,{"ok":True,"savedAt":saved_at,"revision":revision,"serverMode":True})
        if path == '/api/v1/backup' and method=='POST':
            with LOCK:
                dest=backup_current(True)
            return self._json(200,{"ok":True,"path":str(dest) if dest else None,"createdAt":now_iso()})
        if path == '/api/v1/server-info' and method=='GET':
            return self._json(200,{"version":VERSION,"root":str(ROOT),"web":str(WEB),"workspace":str(WORKSPACE)})
        return self._json(404,{"error":"not_found"})

    def _static(self):
        if not self._web_auth():
            return self._challenge()
        raw=urlparse(self.path).path
        path=unquote(raw).lstrip('/')
        if path.startswith('api/'): return self._json(404,{"error":"not_found"})
        if path.startswith('server/') or path.startswith('.git/'):
            return self._json(404,{"error":"not_found"})
        target=(WEB/path).resolve() if path else (WEB/'index.html').resolve()
        try: target.relative_to(WEB.resolve())
        except Exception: return self.send_error(403)
        if target.is_dir(): target=target/'index.html'
        if not target.exists() or not target.is_file():
            target=WEB/'index.html'
        if not target.exists(): return self.send_error(503,"WebApp not installed")
        data=target.read_bytes(); ctype=mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type',ctype)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('X-Frame-Options','DENY')
        if target.name in ('index.html','app.js','agileflow-manifest.json'): self.send_header('Cache-Control','no-cache')
        else: self.send_header('Cache-Control','public, max-age=3600')
        self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path.startswith('/api/v1/'): return self._api('GET')
        return self._static()
    def do_POST(self):
        if urlparse(self.path).path.startswith('/api/v1/'): return self._api('POST')
        return self._json(404,{"error":"not_found"})
    def do_PUT(self):
        if urlparse(self.path).path.startswith('/api/v1/'): return self._api('PUT')
        return self._json(404,{"error":"not_found"})

if __name__=='__main__':
    print(f"AgileFlow Online Server {VERSION} -> http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
