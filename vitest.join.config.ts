// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The join test's own run (npm run test:join), outside the default suite: it
// fails until every wave unit the manifest names has landed (scripts/ext/join.test.ts).
import base from './vite.config';

export default { ...base, test: { ...base.test, include: ['scripts/ext/join.test.ts'] } };
