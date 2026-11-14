# Provisioning for the local test stack

`docker-compose.yaml` in the project root mounts this folder into Grafana.

- `datasources/datasources.yml`: the TestData data source and `VictoriaMetrics (local)`
  (Prometheus type, uid `glide-vm`, scrape interval 1 s, incremental querying off so every
  refresh returns the full range, like production).
- `dashboards/glide-test-local.json`: "Glide test (local)", uid `glide-local`. Pairs of panels
  with identical queries and field config: the built-in Time series panel on the left, Glide on
  the right.

Grafana re-reads the dashboards folder every 10 seconds. Bind mounts on Windows and macOS do not
always deliver file changes, so if an edit does not show up, restart Grafana:

```bash
docker compose restart grafana
```

Background: [Provision dashboards and data sources](https://grafana.com/tutorials/provision-dashboards-and-data-sources/).
