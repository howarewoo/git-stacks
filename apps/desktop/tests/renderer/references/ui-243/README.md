# Approved Git Stacks v5 UI reference

Tracking issue: https://github.com/howarewoo/git-stacks/issues/243

`git-stacks-v5-demo.zip` contains the exact, unmodified `git-stacks-workbench-v5.html` approved by the repository owner in the design conversation. Download the ZIP, extract it, and open the HTML in a desktop browser. The HTML is self-contained and requires no server, build step, installation, or network connection.

This directory is an archival reference, not production UI code or a replacement design guide. Implement the approved experience with the shared `@git-stacks/ui` components and the updated root `PRODUCT.md` / `DESIGN.md` contract owned by #244. Do not embed the prototype, its sample records, or its simulated operations in the production desktop bundle.

## Integrity

- Archive: `git-stacks-v5-demo.zip`
- Archive size: 45,041 bytes
- Archive SHA-256: `8b0d48f11e774a365f621b0b8f8496380b8f1efddcb808f2f804bc533f1e5a44`
- Extracted HTML: `git-stacks-workbench-v5.html`
- Extracted HTML size: 165,707 bytes
- Extracted HTML SHA-256: `e46de09e3502ac917589b4fb1c2f3cb0419f2f9cadb899709bed5a5adc3e3db2`
- Original conversation preview: 1536 x 1000 pixels; SHA-256 `db0c965b1f4dc6384db3eeb176df1cedecd6029fc48d215d68cd5a8bebf38b7e`. The PNG is not included in this archive; the HTML is the complete interactive reference.

The prototype's records, diffs, discovery, and operations are simulated. Prototype browser checks are not evidence of production Git, GitHub, concurrency, accessibility, or packaging correctness. Production acceptance belongs to #255 and the relevant implementation issues.

Preserve this archive unchanged. Link the immutable reference commit from #243 so future implementation changes cannot silently replace the approved target.
