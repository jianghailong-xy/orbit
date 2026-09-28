# TEMPORARY evidence probe — never merged

The iPhone session list's options menu (`AgentsView.sessionOptionsMenu`) draws its titles on two
edges under iOS 26: a checkmark *image* takes an icon column that only its own row reserves. This
probe builds the menu as shipped plus three candidate rewrites into a throwaway app, and a UI test
opens each one on an iOS 26 simulator and photographs it, so the choice is made from what the
system actually draws:

- `shipped` — the code as it is on main (checkmarks are `Label(…, systemImage: "checkmark")`)
- `A` — system checks (`Toggle`), no icons anywhere
- `B` — system checks, the shipped `tag` / `gearshape` icons kept on their two rows
- `C` — system checks, an icon on every row
- `real` / `real-ipad` — the function that ships, cut out of `AgentsView.swift` by `ios/extract.py`
  (iPhone, and the iPad shape without the scope rows)

Each is shot with nothing chosen (`default`) and with every option set (`full`: Completed, a tag
filter, Group by Tag on), and the Filter by Tag submenu is opened once per variant.
