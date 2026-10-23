# Hubward

Live EMT bus arrivals and BiciMAD dock counts for a rider's own places in
Madrid, and how to get from where they stand to the places they head for.

## Language

**Hub**:
A place the rider regularly heads for, such as home or work, which the app plans a way to.
_Avoid_: destination (when the saved place is meant), place

**Board**:
Every arrival EMT currently predicts at one bus stop, with the time it was read.
_Avoid_: arrivals list, estimations

**Planner**:
The part of Hubward that chooses how to reach each Hub — or a one-off place the rider searched for — from where they stand right now: by bus, with one transfer, by BiciMAD, or on foot.
_Avoid_: journey service, router

**Account**:
The EMT login whose quota an EMT call spends: the rider's own connected login, or the shared one.
_Avoid_: connection (for the login itself), credentials, user
