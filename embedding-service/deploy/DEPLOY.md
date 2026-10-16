# VM deployment

Use an Ubuntu or Oracle Linux aarch64 VM (the target is VM.Standard.A1.Flex with 6 GB RAM; setup adds a 4 GB swap file because the model peaks near 4 GB) and enough disk for the model and SQLite database. Keep the service bound to loopback and expose it through a Cloudflare Tunnel or SSH tunnel.

From the Mac, sync the local model directory (the model is not included in this repository):

```sh
rsync -a --info=progress2 "$HOME/dev/gemini embedding 2/models/embeddinggemma-2/" ubuntu@VM:/tmp/embeddinggemma-2/
ssh ubuntu@VM 'sudo mkdir -p /opt/models/embeddinggemma-2 && sudo rsync -a /tmp/embeddinggemma-2/ /opt/models/embeddinggemma-2/'
```

Copy `embedding-service/` to the VM, then install it:

```sh
rsync -a --exclude='.venv' embedding-service/ ubuntu@VM:/tmp/sisic-embed/
ssh ubuntu@VM 'sudo bash /tmp/sisic-embed/deploy/setup_vm.sh /tmp/sisic-embed'
ssh ubuntu@VM 'sudo systemctl enable --now sisic-embed && sudo systemctl status sisic-embed'
```

Setup creates `/etc/sisic-embed.env` with a random token if the file is absent and restricts it to root. The service account reads it through systemd. Retrieve the token securely on the VM; do not paste it into shell history or logs. Check health locally:

```sh
ssh -L 8765:127.0.0.1:8765 ubuntu@VM
curl http://127.0.0.1:8765/health
```

For an authenticated request, load the token into a local environment variable using your secret manager and pass it as `Authorization: Bearer $SISIC_EMBED_TOKEN`; never commit it. For example, an empty job queue is checked with:

```sh
curl -H "Authorization: Bearer $SISIC_EMBED_TOKEN" http://127.0.0.1:8765/jobs
```

Alternatively, configure a Cloudflare Tunnel to forward a protected hostname to `http://127.0.0.1:8765`. Require Cloudflare Access and retain the service bearer token as a second gate. Do not bind uvicorn to a public interface.

## Measure real speed first

```sh
ssh ubuntu@VM 'cd /opt/sisic-embed && sudo -u sisic-embed .venv/bin/python bench_vm.py --model /opt/models/embeddinggemma-2 --clips 6'
```

The estimate in the handoff (about 25 s per clip on one Ampere core) is calculated, not measured; use this output to plan.
