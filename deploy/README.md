# Deploying Glide time series to the production Grafana

Plugin id: `bobby-glide-panel`. The plugin is unsigned and frontend only: Grafana just serves its
files to the browser. Nothing in this guide touches existing dashboards.

Assumptions (adjust the variables if they differ):

- Linux host, Grafana runs from the compose project in `/home/ubuntu/arcane/projects/grafana`.
- The Grafana service is called `grafana` and reads its environment from `env_file: .env`.
- Files in the stack folder are owned by `65532:65532`.
- Target Grafana is 13.x (the plugin requires 13.0.0 or newer).

Every block can be pasted as a whole. Run the steps in order. Blocks marked "on your workstation"
run there; all others run on the host in one SSH session, except where a step says "fresh shell".

## 0. Look before changing anything

```bash
cd /home/ubuntu/arcane/projects/grafana
uname -m
docker compose ps grafana
docker compose images grafana
ls -ln .env docker-compose.y*ml compose.y*ml 2>/dev/null
```

Expect: `x86_64` or `aarch64` (both work: the Node image is multi-arch and the build output is
plain JavaScript, identical on every architecture), the grafana service `running`, a 13.x image
tag, and owner `65532 65532` on the files.

## 1. Get the plugin files onto the host

Pick ONE of 1a or 1b. Both end with the built plugin in `plugins/bobby-glide-panel`.

### 1a. Build on the host in a throwaway Node container

On your workstation, from the project root (Git Bash on Windows works), copy the source without
`node_modules`, `dist` and `.git`. Replace `HOST`:

```bash
HOST=ubuntu@your-grafana-host
ssh "$HOST" 'mkdir -p /home/ubuntu/arcane/projects/grafana/plugins-src/glide-panel'
tar --exclude=./node_modules --exclude=./dist --exclude=./.git \
    --exclude=./test-results --exclude=./playwright-report -czf - . \
  | ssh "$HOST" 'tar -xzf - -C /home/ubuntu/arcane/projects/grafana/plugins-src/glide-panel'
```

If `mkdir` fails with "Permission denied" (the stack folder belongs to 65532), create the folder
on the host first: `sudo install -d -o "$(id -u)" -g "$(id -g)" /home/ubuntu/arcane/projects/grafana/plugins-src/glide-panel`.

On the host, build. The container runs as your own user, so nothing in the source folder ends up
owned by root, and it is removed when the build ends:

```bash
cd /home/ubuntu/arcane/projects/grafana
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
  -v "$PWD/plugins-src/glide-panel":/src -w /src \
  node:24-bookworm-slim \
  sh -c 'npm ci --no-audit --no-fund && npm run build'
ls plugins-src/glide-panel/dist
```

Expect: a few minutes for `npm ci`, then `webpack ... compiled successfully`, and the listing shows
at least `module.js`, `plugin.json`, `README.md`, `img`. If `module.js` or `plugin.json` is
missing, stop here.

Copy the build output into place with the right owner:

```bash
cd /home/ubuntu/arcane/projects/grafana
sudo rm -rf plugins/bobby-glide-panel.new
sudo mkdir -p plugins
sudo cp -r plugins-src/glide-panel/dist plugins/bobby-glide-panel.new
sudo chown -R 65532:65532 plugins/bobby-glide-panel.new
sudo rm -rf plugins/bobby-glide-panel.old
[ -d plugins/bobby-glide-panel ] && sudo mv plugins/bobby-glide-panel plugins/bobby-glide-panel.old
sudo mv plugins/bobby-glide-panel.new plugins/bobby-glide-panel
ls -ln plugins/bobby-glide-panel
grep -E '"(id|version)"' plugins/bobby-glide-panel/plugin.json
```

Expect: files owned by `65532 65532`, `"id": "bobby-glide-panel"` and a real version number
(not `%VERSION%`). On an update the previous build is kept as `plugins/bobby-glide-panel.old`.

If `plugins` did not exist before and `sudo mkdir` created it, give it the stack owner as well:
`sudo chown 65532:65532 plugins`.

### 1b. Build on your workstation and copy only `dist` with scp

No build and no source on the host. On your workstation, from the project root:

```bash
npm ci
npm run build
HOST=ubuntu@your-grafana-host
ssh "$HOST" 'rm -rf /tmp/bobby-glide-panel'
scp -r dist "$HOST":/tmp/bobby-glide-panel
```

On the host:

```bash
cd /home/ubuntu/arcane/projects/grafana
sudo rm -rf plugins/bobby-glide-panel.new
sudo mkdir -p plugins
sudo cp -r /tmp/bobby-glide-panel plugins/bobby-glide-panel.new
sudo chown -R 65532:65532 plugins/bobby-glide-panel.new
sudo rm -rf plugins/bobby-glide-panel.old
[ -d plugins/bobby-glide-panel ] && sudo mv plugins/bobby-glide-panel plugins/bobby-glide-panel.old
sudo mv plugins/bobby-glide-panel.new plugins/bobby-glide-panel
rm -rf /tmp/bobby-glide-panel
ls -ln plugins/bobby-glide-panel
grep -E '"(id|version)"' plugins/bobby-glide-panel/plugin.json
```

Expect the same as at the end of 1a.

## 2. Mount the plugin into the Grafana container

Back up the compose file, then add ONE line to the `volumes:` list of the `grafana` service
(create the list if the service has none). Use the real file name of the stack
(`docker-compose.yaml`, `docker-compose.yml` or `compose.yaml`):

```bash
cd /home/ubuntu/arcane/projects/grafana
COMPOSE_FILE_NAME=$(ls docker-compose.yaml docker-compose.yml compose.yaml compose.yml 2>/dev/null | head -n 1)
echo "$COMPOSE_FILE_NAME"
sudo cp -p "$COMPOSE_FILE_NAME" "$COMPOSE_FILE_NAME.bak-glide"
```

The line to add with an editor (`sudo nano "$COMPOSE_FILE_NAME"`), indented like the other
entries of that list:

```yaml
- ./plugins/bobby-glide-panel:/var/lib/grafana/plugins/bobby-glide-panel:ro
```

The mount is read-only (`:ro`). If Grafana in this stack uses a different plugins path
(`GF_PATHS_PLUGINS` in `.env` or the compose file), use that path instead of
`/var/lib/grafana/plugins`.

Check the result without starting anything:

```bash
cd /home/ubuntu/arcane/projects/grafana
docker compose config --quiet && echo "compose file is valid"
docker compose config | grep -n -B3 -A3 'bobby-glide-panel'
```

Expect: `compose file is valid` and a bind mount with `read_only: true` under the grafana service.
`docker compose config` prints the resolved environment including secrets, which is why the
second command only shows the lines around the plugin.

## 3. Allow the unsigned plugin in `.env`

Rules for this step: the `GF_SECURITY_SECRET_KEY` line is never edited, moved or printed. Do not
`source .env` and do not open it with a tool that rewrites line endings.

### 3.1 Backup and record the state before

```bash
cd /home/ubuntu/arcane/projects/grafana
sudo cp -p .env .env.bak-glide
echo "secret key line number BEFORE:"
sudo grep -n '^GF_SECURITY_SECRET_KEY=' .env | cut -d: -f1
echo "secret key line fingerprint BEFORE:"
sudo grep '^GF_SECURITY_SECRET_KEY=' .env | sha256sum
echo "number of lines BEFORE:"
sudo grep -c '' .env
echo "existing unsigned plugin setting (nothing printed means none):"
sudo grep -n 'GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS' .env
```

Write down the line number and the fingerprint. The fingerprint is a hash, it does not reveal
the key. Then follow exactly one of 3.2a, 3.2b or 3.2c, depending on the last command.

### 3.2a Nothing was printed: append a new line

First make sure the file ends with a newline, otherwise the new variable would be glued to the
end of the last line:

```bash
cd /home/ubuntu/arcane/projects/grafana
if [ -n "$(sudo tail -c 1 .env)" ]; then
  echo "last line has no newline, adding one"
  printf '\n' | sudo tee -a .env > /dev/null
else
  echo "file ends with a newline, good"
fi
printf 'GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=bobby-glide-panel\n' | sudo tee -a .env > /dev/null
```

Both commands only append to the end of the file. No existing line changes.

### 3.2b A line was printed and it already contains `bobby-glide-panel`

Nothing to do. Continue with 3.3.

### 3.2c A line was printed with other plugin ids

Add the id to that list, separated by a comma. This command changes only that one line, and
only when it starts at the beginning of a line:

```bash
cd /home/ubuntu/arcane/projects/grafana
ENV_MODE=$(sudo stat -c '%a' .env)
sudo sed -i '/^GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=/ s/[[:space:]]*$/,bobby-glide-panel/' .env
sudo chown 65532:65532 .env
sudo chmod "$ENV_MODE" .env
```

`sed -i` writes a new file, which would get root as owner and default permissions; the last two
commands put the original owner and mode back.

If the printed line was commented out (`# GF_PLUGINS_...`) or the value is quoted, do not use the
command: treat it as 3.2a when commented out, or edit the value by hand inside the quotes.

### 3.3 Verify the file

```bash
cd /home/ubuntu/arcane/projects/grafana
echo "secret key line number AFTER:"
sudo grep -n '^GF_SECURITY_SECRET_KEY=' .env | cut -d: -f1
echo "secret key line fingerprint AFTER:"
sudo grep '^GF_SECURITY_SECRET_KEY=' .env | sha256sum
echo "number of lines AFTER:"
sudo grep -c '' .env
echo "unsigned plugin setting (exactly one line, starting with the variable name):"
sudo grep -n 'GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS' .env
echo "lines holding more than one GF_ variable (must print nothing):"
sudo grep -n -E 'GF_[A-Z0-9_]+=.*GF_[A-Z0-9_]+=' .env | cut -d: -f1
echo "variable names of the last 3 lines, values hidden:"
sudo tail -n 3 .env | cut -d= -f1 | cat -A
echo "lines with Windows line endings (must print 0):"
sudo grep -c "$(printf '\r')" .env
echo "owner and mode:"
sudo stat -c '%u:%g %a' .env .env.bak-glide
```

Expect:

- The secret key line number and fingerprint are identical to the BEFORE values.
- The line count grew by 1 after 3.2a and is unchanged after 3.2b and 3.2c. Adding a missing
  final newline ends the last line, it does not add a line.
- Exactly one `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=...` line, and its value contains
  `bobby-glide-panel`.
- Nothing printed under "lines holding more than one GF\_ variable". If a line number is printed
  there, look at that line: either two variables were glued together (restore the backup with
  `sudo cp -p .env.bak-glide .env` and start step 3 again), or a value legitimately contains the
  text `GF_...=`.
- The last name shown is `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS$` after 3.2a, alone on its
  line. Each name ends with `$`. A `^M` before the `$` means a Windows line ending.
- `0` lines with Windows line endings. If the backup also has some
  (`sudo grep -c "$(printf '\r')" .env.bak-glide` prints the same number), they were there
  already and this step did not introduce them. Otherwise restore the backup.
- Owner and mode equal to the backup's.

## 4. Recreate the Grafana container

Use a fresh shell: log out and open a new SSH session, so no variable from this session can
override the values in `.env`. Never `source .env` in the shell that runs compose.

```bash
cd /home/ubuntu/arcane/projects/grafana
env | grep -c '^GF_'
docker compose up -d --force-recreate grafana
docker compose ps grafana
```

Expect: the first command prints `0` (no `GF_` variable in the shell), compose prints
`Container ... Recreated` and `Started`, and the service is `running` (or `healthy` after its
health check passes). Grafana is unavailable for a few seconds. Sessions stay valid because the
secret key did not change.

## 5. Verify

```bash
cd /home/ubuntu/arcane/projects/grafana
echo "--- setting picked up (1 or more expected):"
docker compose logs --since 10m grafana 2>&1 | grep -c 'GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS'
echo "--- log lines about the plugin:"
docker compose logs --since 10m grafana 2>&1 | grep -i 'bobby-glide-panel' | grep -v 'Config overridden' | cut -c1-300
echo "--- errors since the restart:"
docker compose logs --since 10m grafana 2>&1 | grep -E 'level=(error|crit)' | cut -c1-300
```

Expect:

- At least one line for the setting (`Config overridden from Environment variable`).
- For the plugin: a warning that an unsigned plugin is permitted, with
  `pluginId=bobby-glide-panel`. That warning is the proof that Grafana found and loaded it.
  A line containing `plugin is unsigned` or `signature` together with `level=error` means the
  `.env` setting did not reach the container: recheck step 3.3 and step 4.
- No new errors. Compare with errors that were already there before the change if any show up.

Check over HTTP as well (adjust port and scheme to the stack; behind a login the second request
needs a token, the first one normally does not):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/public/plugins/bobby-glide-panel/plugin.json
curl -s -H "Authorization: Bearer $GRAFANA_TOKEN" http://localhost:3000/api/plugins/bobby-glide-panel/settings | head -c 300; echo
```

Expect `200` from the first request. The second (optional, needs a service account token in
`GRAFANA_TOKEN`) returns JSON with `"id":"bobby-glide-panel"`; `Plugin not found` means it is
not loaded.

In the browser: open any dashboard, edit a panel, open the visualization picker and search for
"Glide". "Glide time series" must be listed. Do a hard reload (Ctrl+Shift+R) first if Grafana
was already open.

## 6. Import the test dashboards

Dashboards, New, Import, then upload:

| File                           | uid             | Range              | Refresh | Content                                          |
| ------------------------------ | --------------- | ------------------ | ------- | ------------------------------------------------ |
| `glide-test-dashboard.json`    | `glide-test`    | now-5m to now-6s   | 1s      | Hosts: CPU, network in/out, RAM stacked          |
| `glide-test-dashboard-5s.json` | `glide-test-5s` | now-15m to now-10s | 5s      | Containers: RAM per container, plain and stacked |

Each row is a pair with identical queries and field config: the built-in Time series panel on the
left, Glide on the right. Both dashboards use the Prometheus data source with uid
`bg48bd51xmz28a` and shared crosshair. They are new dashboards with their own uids, existing
dashboards are not modified.

Two things to check after the import:

- **Container metric name.** The container panels query
  `sum by (instance, name) (container_memory_usage_bytes{name!=""})`. That metric and label name
  are an assumption (cAdvisor style). If the panels are empty, open the RAM panel of the existing
  Docker dashboard, copy its query, and paste it into both panels of each pair (standard and
  Glide must stay identical). Keep the legend format `{{instance}} / {{name}}` or adapt it to the
  labels of that query.
- **Network device filter.** The network query excludes `lo|veth.*|docker.*|br-.*|eth.*`. If
  the hosts' physical interfaces are called `eth0`, that filter removes them:
  compare with the existing hosts dashboard and use its filter.

What to look at: the right panels should scroll evenly, without the once-per-refresh jump of the
left panels; lines, fills, thresholds, legend values, tooltip content and colours should match the
left panel; hovering one panel shows the crosshair in the others.

## Updating the plugin later

Repeat step 1 (1a or 1b). Then, in a fresh shell:

```bash
cd /home/ubuntu/arcane/projects/grafana
docker compose restart grafana
```

Grafana reads `plugin.json` at startup, so a restart is needed for a new version number to
show. Reload the browser with Ctrl+Shift+R afterwards. Steps 2 and 3 are not repeated.

## Rollback

Switching a panel back never needs the server. Two ways:

- **Lossless (recommended): swap the type in the JSON.** Export the dashboard as JSON (classic
  format), replace every `"type": "bobby-glide-panel"` with `"type": "timeseries"`, and import
  it again with the same uid (overwrite). Field config, overrides, legend and tooltip options
  stay exactly as they were, because both panel types use the same option names. The leftover
  `"glide": {...}` block in the panel options is ignored by the Time series panel.
- **In the panel editor:** choose "Time series" in the visualization picker and save. Field
  config and overrides (units, thresholds, colours, negative-Y, stacking, line and fill styles)
  are kept, but Grafana's Time series panel resets the legend and tooltip options to its defaults
  when it is switched to from any other panel type, so set those again before saving.

The other direction (Time series to Glide in the panel editor) keeps legend and tooltip options
too, because Glide carries them over.

To remove the plugin completely:

1. Switch every panel that uses "Glide time series" back to "Time series" (or delete the two
   imported test dashboards). Panels left on the plugin show "Panel plugin not found" after
   removal. Their settings survive and they work again once switched to Time series.
2. Restore the compose file and remove the setting from `.env`. The `sed` command deletes only a
   line that is exactly the one added in 3.2a. If you used 3.2c, remove `,bobby-glide-panel`
   from the list by hand instead.

   ```bash
   cd /home/ubuntu/arcane/projects/grafana
   COMPOSE_FILE_NAME=$(ls docker-compose.yaml docker-compose.yml compose.yaml compose.yml 2>/dev/null | head -n 1)
   sudo cp -p "$COMPOSE_FILE_NAME.bak-glide" "$COMPOSE_FILE_NAME"
   echo "secret key line number BEFORE:"; sudo grep -n '^GF_SECURITY_SECRET_KEY=' .env | cut -d: -f1
   echo "secret key fingerprint BEFORE:"; sudo grep '^GF_SECURITY_SECRET_KEY=' .env | sha256sum
   ENV_MODE=$(sudo stat -c '%a' .env)
   sudo sed -i '/^GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=bobby-glide-panel[[:space:]]*$/d' .env
   sudo chown 65532:65532 .env
   sudo chmod "$ENV_MODE" .env
   echo "secret key line number AFTER:"; sudo grep -n '^GF_SECURITY_SECRET_KEY=' .env | cut -d: -f1
   echo "secret key fingerprint AFTER:"; sudo grep '^GF_SECURITY_SECRET_KEY=' .env | sha256sum
   sudo grep -c 'GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS' .env
   ```

   Expect: the fingerprint is unchanged and the last command prints `0`. The line number is
   unchanged too, unless the secret key line was below the removed line, in which case it is
   smaller by exactly 1. Restoring the compose backup also discards any other compose edit made
   since step 2; if there were any, remove just the volume line by hand instead.

3. In a fresh shell:

   ```bash
   cd /home/ubuntu/arcane/projects/grafana
   docker compose up -d --force-recreate grafana
   docker compose logs --since 5m grafana 2>&1 | grep -E 'level=(error|crit)' | cut -c1-300
   ```

4. Optional cleanup once everything is confirmed:

   ```bash
   cd /home/ubuntu/arcane/projects/grafana
   sudo rm -rf plugins/bobby-glide-panel plugins/bobby-glide-panel.old plugins-src/glide-panel
   sudo rm -f .env.bak-glide docker-compose*.bak-glide compose*.bak-glide
   ```

A faster partial rollback, if only the plugin build is bad: put the previous build back and
restart.

```bash
cd /home/ubuntu/arcane/projects/grafana
sudo mv plugins/bobby-glide-panel plugins/bobby-glide-panel.bad
sudo mv plugins/bobby-glide-panel.old plugins/bobby-glide-panel
docker compose restart grafana
```
