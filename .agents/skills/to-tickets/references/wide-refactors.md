# Wide refactors

1. **Expand.** Add the new form beside the old so existing callers keep working.
2. **Migrate.** Group callers by package, directory or another verifiable boundary. Make each batch depend on the expand issue. Keep the old form available so each batch passes its own checks.
3. **Contract.** Make the removal issue depend on every migration issue. Verify that no caller still uses the old form before removing it.

If even the migration batches cannot pass independently, propose a shared integration branch and a final issue that depends on all change issues and verifies the combined change. Include how the changes would be completed on the branch and how the verified branch would be delivered. Keep the breakdown in draft until the owner approves a delivery route that supports those steps. Follow the existing review and delivery rules.
