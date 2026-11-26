`yoda-realm.json` is a DEV ONLY realm import: its users (`somchai`, `nurse1`, password `dev`) are throwaway test accounts. Never use it in production.

`themes/yoda` is the Yoda login theme. The dev compose file mounts `themes/` at `/opt/keycloak/themes` and the dev
realm uses it (`loginTheme: yoda`, Thai default, English). `start-dev` turns theme caching off, so edits show on
reload. The realm import only runs when the realm does not exist yet: on an older dev container, pick the theme in
Realm settings → Themes, or recreate the container. Installing it on a production Keycloak: `docs/operations.md`
§2 "Login theme".

`themes/yoda-plain` is the same theme without the fun touches (static mark, no starfield, no playful line); the
`yoda` theme also turns them off when Keycloak runs with `YODA_LOGIN_FUN_MODE=false`. See
`docs/design/jedi-touch.md`.
