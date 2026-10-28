# Online update behavior

Startup checks once after 15 seconds on supported packaged Windows x64 builds.
Checking retrieves and verifies release metadata only. A newer version shows its
version and package size. Downloading the package requires **Download update**;
installation separately requires **Restart and update**. Closing Desktop is not
an installation request. Manual checks cancel the pending startup timer.

The download action rechecks signed metadata before downloading. A verified
package remains available after an installation admission failure. Force-stop
requests must still pass the existing task-stop admission gate; failure does not
start the installer or quit Desktop.

## Networking and diagnostics

An empty proxy address uses Electron's system network configuration. Users do not
need to enter proxy credentials preemptively. A manually configured proxy uses
only credentials entered for this Desktop process; passwords are not persisted.
System-proxy authentication challenges and manual-proxy authentication failures
have distinct messages. Automatic check errors are visible and dismissible, with
retry and network-settings actions.

The update card displays the selected mode and the latest host's proxy resolution.
A resolved proxy configuration is not proof that this proxy was ultimately used
or that authentication succeeded (PAC can provide fallback routes).

`online-update.log` is written in Electron's logs directory. It records timestamps,
check/download/install requests, automatic versus manual checks, requested force
stop, installer handoff, phases, versions, and sanitized network summaries. It
never serializes credentials, proxy endpoints, URL queries, or raw PAC results.
Download progress events are not logged individually. Request records establish
which operation ran, not proof of a physical user click.

## Validation

Automated coverage exercises metadata-only checks, explicit signed-package
download, changed releases, proxy credential boundaries, system routing summaries,
visible automatic failures, admission rejection and forced-stop rejection. These
tests simulate GitHub responses and the Windows launcher while verifying real
signed ZIP fixtures. Windows enterprise proxy authentication and end-to-end
installation remain real-machine acceptance checks.
