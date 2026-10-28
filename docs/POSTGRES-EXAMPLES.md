# PostgreSQL example caveats

When using the bundled PostgreSQL examples, apply these caveats. In `security-rls-performance`, the policy's calling role
needs `EXECUTE` on `private.is_team_member(bigint)` after the revocations: grant it only to intended policy callers,
such as `authenticated` when that is the policy's intended role. Keep the non-exposed schema, identity check and
restricted search path; retain revocations for `PUBLIC` and roles that do not need the helper, including unrelated
anonymous or service roles. [`SECURITY DEFINER`](https://www.postgresql.org/docs/16/sql-createfunction.html) changes
execution privileges, not permission to call. In `schema-constraints`, scope both the check-constraint and foreign-key
existence queries by `conname` and `conrelid`: schema-qualify the target table in `ALTER TABLE` and resolve that same
name through `regclass`. [Constraint names alone are not unique](https://www.postgresql.org/docs/17/catalog-pg-constraint.html).

In `conn-prepared-statements`, `DEALLOCATE` does not keep separately executed statements on one server connection.
Use session pooling or a direct connection for the SQL `PREPARE`/`EXECUTE`/`DEALLOCATE` sequence; do not treat it as a
transaction-pooling fix. [PgBouncer does not support this SQL sequence in transaction pooling](https://www.pgbouncer.org/features.html).
In `lock-deadlock-prevention`, retain ordered `SELECT ... ORDER BY id FOR UPDATE` inside the transaction before the
single `UPDATE`; one statement does not atomically acquire every row lock. All competing transactions must follow the
[same lock order](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-DEADLOCKS).
