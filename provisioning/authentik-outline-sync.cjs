#!/usr/bin/env node

const crypto = require("node:crypto")
const { Client } = require("pg")

const env = process.env
const authentikUrl = authentikBaseUrl().replace(/\/+$/, "")
const authentikToken = firstRequired(["OUTLINE_SYNC_AUTHENTIK_TOKEN", "AUTHENTIK_API_TOKEN", "AUTHENTIK_TOKEN"])
const databaseUrl = required("DATABASE_URL")
const intervalSeconds = numberEnv("OUTLINE_SYNC_INTERVAL_SECONDS", 900)
const accessGroups = csv("OUTLINE_SYNC_ACCESS_GROUPS", "wiki-access,wiki-admin")
const adminGroups = csv("OUTLINE_SYNC_ADMIN_GROUPS", "wiki-admin")
const managedGroupNames = csv(
    "OUTLINE_SYNC_GROUPS",
    "wiki-access,wiki-admin,TekKom,Styret,Aktiv,BarKom,BedKom,CTFkom,EvntKom,Fondet,PR,SATkom"
)
const disableMissingUsers = env.OUTLINE_SYNC_DISABLE_MISSING === "true"

let shuttingDown = false

process.on("SIGINT", stop)
process.on("SIGTERM", stop)

if (process.argv.includes("--loop")) {
    runLoop().catch(fail)
} else {
    runSync().catch(fail)
}

async function runLoop() {
    while (!shuttingDown) {
        await runSync()
        await delay(intervalSeconds * 1000)
    }
}

async function runSync() {
    const startedAt = new Date()
    const users = await fetchAuthentikUsers()
    const selectedUsers = users.filter(shouldProvisionUser)
    const client = new Client({ connectionString: databaseUrl })

    await client.connect()
    try {
        await client.query("begin")
        const context = await loadOutlineContext(client)
        const syncedUsers = await syncUsers(client, context, selectedUsers)
        const syncedGroups = await syncGroups(client, context, selectedUsers, syncedUsers)

        if (disableMissingUsers) {
            await suspendMissingUsers(client, context, syncedUsers)
        }

        await client.query("commit")
        logResult(startedAt, users.length, selectedUsers.length, syncedUsers.size, syncedGroups)
    } catch (error) {
        await client.query("rollback")
        console.error(JSON.stringify({ ok: false, error: error.message, at: new Date().toISOString() }))
        throw error
    } finally {
        await client.end()
    }
}

async function fetchAuthentikUsers() {
    const users = []
    const pageSize = 200
    let nextUrl = `${authentikUrl}/api/v3/core/users/?page_size=${pageSize}`

    while (nextUrl) {
        const response = await fetch(nextUrl, {
            headers: {
                authorization: `Bearer ${authentikToken}`,
                accept: "application/json",
            },
        })

        if (!response.ok) {
            throw new Error(`Authentik user fetch failed with HTTP ${response.status}`)
        }

        const page = await response.json()
        users.push(...(page.results ?? []))
        nextUrl = nextPageUrl(page.pagination?.next, pageSize)
    }

    return users
}

function nextPageUrl(nextPage, pageSize) {
    if (!nextPage) {
        return null
    }
    if (typeof nextPage === "string" && nextPage.startsWith("http")) {
        return nextPage
    }
    return `${authentikUrl}/api/v3/core/users/?page_size=${pageSize}&page=${nextPage}`
}

async function loadOutlineContext(client) {
    const team = await one(client, `select id from teams where "deletedAt" is null order by "createdAt" asc limit 1`)
    const provider = await one(
        client,
        `select id from authentication_providers
        where name = 'oidc' and enabled = true and "teamId" = $1
        order by "createdAt" asc limit 1`,
        [team.id]
    )
    const creator = await one(
        client,
        `select id from users
        where "teamId" = $1 and role = 'admin' and "deletedAt" is null
        order by "createdAt" asc limit 1`,
        [team.id]
    )

    return {
        teamId: team.id,
        authProviderId: provider.id,
        creatorId: creator.id,
    }
}

async function syncUsers(client, context, authentikUsers) {
    const syncedUsers = new Map()

    for (const authentikUser of authentikUsers) {
        const email = normalizeEmail(authentikUser.email)
        const name = displayName(authentikUser, email)
        const role = hasAnyGroup(authentikUser, adminGroups) ? "admin" : "viewer"
        const userId = await upsertOutlineUser(client, context, email, name, role)

        await upsertAuthentication(client, context, userId, authentikUser.uid)
        syncedUsers.set(authentikUser.pk, { id: userId, auth: authentikUser })
    }

    return syncedUsers
}

async function upsertOutlineUser(client, context, email, name, role) {
    const existing = await client.query(
        `select id from users where lower(email) = lower($1) and "teamId" = $2 limit 1`,
        [email, context.teamId]
    )

    if (existing.rowCount > 0) {
        const userId = existing.rows[0].id
        await client.query(
            `update users
            set name = $1, role = $2, "updatedAt" = now(), "deletedAt" = null, "suspendedAt" = null
            where id = $3`,
            [name, role, userId]
        )
        return userId
    }

    const userId = crypto.randomUUID()
    await client.query(
        `insert into users
            (id, email, name, "jwtSecret", "createdAt", "updatedAt", "teamId", role, "notificationSettings")
        values ($1, $2, $3, $4, now(), now(), $5, $6, '{}'::jsonb)`,
        [userId, email, name, crypto.randomBytes(32), context.teamId, role]
    )
    return userId
}

async function upsertAuthentication(client, context, userId, providerUserId) {
    await client.query(
        `insert into user_authentications
            (id, "userId", "authenticationProviderId", "providerId", scopes, "createdAt", "updatedAt")
        values ($1, $2, $3, $4, array['openid', 'profile', 'email'], now(), now())
        on conflict ("providerId", "userId")
        do update set "updatedAt" = now(), "authenticationProviderId" = excluded."authenticationProviderId"`,
        [crypto.randomUUID(), userId, context.authProviderId, providerUserId]
    )
}

async function syncGroups(client, context, selectedUsers, syncedUsers) {
    const groups = collectManagedGroups(selectedUsers)
    let memberships = 0

    for (const group of groups.values()) {
        const groupId = await upsertGroup(client, context, group)
        const expectedUserIds = []

        for (const authUser of selectedUsers) {
            if (!hasGroup(authUser, group.name)) {
                continue
            }

            const syncedUser = syncedUsers.get(authUser.pk)
            if (!syncedUser) {
                continue
            }

            expectedUserIds.push(syncedUser.id)
            await client.query(
                `insert into group_users
                    ("userId", "groupId", "createdById", "createdAt", "updatedAt", permission)
                values ($1, $2, $3, now(), now(), 'member')
                on conflict ("groupId", "userId") do update set "updatedAt" = now()`,
                [syncedUser.id, groupId, context.creatorId]
            )
            memberships += 1
        }

        await client.query(
            `delete from group_users where "groupId" = $1 and not ("userId" = any($2::uuid[]))`,
            [groupId, expectedUserIds]
        )
    }

    return { groups: groups.size, memberships }
}

async function upsertGroup(client, context, group) {
    const externalId = `authentik:${group.pk}`
    const existing = await client.query(
        `select id from groups
        where "teamId" = $1 and "deletedAt" is null and ("externalId" = $2 or lower(name) = lower($3))
        order by "createdAt" asc limit 1`,
        [context.teamId, externalId, group.name]
    )

    if (existing.rowCount > 0) {
        const groupId = existing.rows[0].id
        await client.query(
            `update groups set name = $1, "externalId" = $2, "updatedAt" = now() where id = $3`,
            [group.name, externalId, groupId]
        )
        return groupId
    }

    const groupId = crypto.randomUUID()
    await client.query(
        `insert into groups
            (id, name, "teamId", "createdById", "createdAt", "updatedAt", "externalId")
        values ($1, $2, $3, $4, now(), now(), $5)`,
        [groupId, group.name, context.teamId, context.creatorId, externalId]
    )
    return groupId
}

async function suspendMissingUsers(client, context, syncedUsers) {
    const userIds = [...syncedUsers.values()].map((user) => user.id)
    await client.query(
        `update users
        set "suspendedAt" = now(), "updatedAt" = now()
        where "teamId" = $1 and "deletedAt" is null and not (id = any($2::uuid[]))`,
        [context.teamId, userIds]
    )
}

function collectManagedGroups(users) {
    const groups = new Map()
    for (const user of users) {
        for (const group of groupObjects(user)) {
            if (managedGroupNames.includes(group.name)) {
                groups.set(group.name, group)
            }
        }
    }
    return groups
}

function shouldProvisionUser(user) {
    return Boolean(user.is_active && normalizeEmail(user.email) && hasAnyGroup(user, accessGroups))
}

function hasAnyGroup(user, names) {
    return groupObjects(user).some((group) => names.includes(group.name))
}

function hasGroup(user, name) {
    return groupObjects(user).some((group) => group.name === name)
}

function groupObjects(user) {
    return Array.isArray(user.groups_obj) ? user.groups_obj : []
}

function displayName(user, email) {
    return user.name || [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || email
}

function normalizeEmail(email) {
    return typeof email === "string" ? email.trim().toLowerCase() : ""
}

function logResult(startedAt, fetchedUsers, selectedUsers, syncedUsers, syncedGroups) {
    console.log(
        JSON.stringify({
            ok: true,
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            fetchedUsers,
            selectedUsers,
            syncedUsers,
            syncedGroups: syncedGroups.groups,
            syncedMemberships: syncedGroups.memberships,
            accessGroups,
            adminGroups,
            managedGroupNames,
            intervalSeconds,
            disableMissingUsers,
        })
    )
}

async function one(client, sql, params = []) {
    const result = await client.query(sql, params)
    if (result.rowCount !== 1) {
        throw new Error(`Expected one row, got ${result.rowCount}`)
    }
    return result.rows[0]
}

function csv(name, fallback) {
    return (env[name] || fallback)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
}

function numberEnv(name, fallback) {
    const value = Number(env[name] || fallback)
    return Number.isFinite(value) && value > 0 ? value : fallback
}

function required(name) {
    const value = env[name]
    if (!value) {
        throw new Error(`${name} is required`)
    }
    return value
}

function firstRequired(names) {
    for (const name of names) {
        if (env[name]) {
            return env[name]
        }
    }
    throw new Error(`${names.join(" or ")} is required`)
}

function authentikBaseUrl() {
    if (env.AUTHENTIK_URL) {
        return env.AUTHENTIK_URL
    }
    const issuer = env.OIDC_ISSUER_URL || ""
    const marker = "/application/o/"
    const markerIndex = issuer.indexOf(marker)
    if (markerIndex !== -1) {
        return issuer.slice(0, markerIndex)
    }
    return required("AUTHENTIK_URL")
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function stop() {
    shuttingDown = true
}

function fail(error) {
    console.error(JSON.stringify({ ok: false, error: error.message, at: new Date().toISOString() }))
    process.exitCode = 1
}
