# Example Table Structures from Normalized Case Tables for BHA

This document describes example table structures that can be built from normalized case tables for use in case searches based on real BHA use cases

---

## Search and Admit

Fetches all clients with their associated alias records. Aliases are left-joined, so clients without any aliases are still returned. 
A user can search for a matching client in the system before creating a new client record.

```sql
SELECT
    c.case_id,
    c.first_name,
    c.middle_name,
    c.last_name,
    c.dob,
    c.social_security_number,
    c.medicaid_id,
    c.central_registry,
    c.current_status,
    a.case_id                  AS alias_case_id,
    a.first_name               AS alias_first_name,
    a.last_name                AS alias_last_name,
    a.dob                      AS alias_dob,
    a.medicaid_id              AS alias_medicaid,
    a.social_security_number   AS alias_ssn
FROM case_client c
LEFT JOIN case_alias a ON c.case_id = a.parent_case_id
ORDER BY c.case_id ASC
```

---

## Search My Clients

Use case: Extends the client/alias query with service episode data. The INNER JOIN on `case_service` means only clients with at least one service record are returned. Aliases are still left-joined, so a client without aliases will not be dropped.
This allows for users to search for clients based on whether there is a service case associated with one of the clinics for the user's locations.
```sql
SELECT
    c.case_id,
    c.first_name,
    c.middle_name,
    c.last_name,
    c.dob,
    c.social_security_number,
    c.medicaid_id,
    c.central_registry,
    c.current_status,
    a.case_id                  AS alias_case_id,
    a.first_name               AS alias_first_name,
    a.last_name                AS alias_last_name,
    a.dob                      AS alias_dob,
    a.medicaid_id              AS alias_medicaid_id,
    a.social_security_number   AS alias_social_security_number,
    s.admission_date           AS service_admission_date,
    s.discharge_date           AS service_discharge_date,
    s.clinic_case_id           AS service_clinic_case_id,
    s.current_status           AS service_current_status
FROM case_client c
-- Keeps all combinations if aliases exist, but doesn't drop clients without aliases
LEFT JOIN case_alias a ON c.case_id = a.client_case_id
-- Forces the query to ONLY return rows if a service record exists
INNER JOIN case_service s ON c.case_id = s.parent_case_id
```

---

## Search Beds

Use case: Fetches capacity records enriched with clinic details and unit names. The windowed `MIN()` on `date_opened` derives the earliest active date per clinic, with `2020-01-01` treated as a sentinel null value. Units are joined via an array membership check rather than a direct foreign key.
This allows for users to search for open bed (represented by capacity cases) and also to see relevant informtion for that capacity case's unit and parent clinic.

```sql
SELECT
    cap.case_id                                                             AS capacity_case_id,
    c.display_name                                                          AS clinic_display_name,
    c.insurance                                                             AS clinic_insurance,
    c.phone_referrals                                                       AS clinic_phone_referrals_display,
    c.map_coordinates                                                       AS clinic_map_coordinates,
    c.address_full                                                          AS clinic_address_full,
    c.mental_health_settings                                                AS clinic_mental_health_settings,
    c.residential_services                                                  AS clinic_residential_services,
    cap.view_more_info_smartlink_bed_tracker,
    un.case_name                                                            AS unit_name,
    cap.age_served,
    cap.gender_served,
    cap.open_beds,
    -- The expression here is an example; right now there is some weird denormalization
    -- and the property we want isn't even stored on the capacity table, so the logic
    -- is represented using date_opened.
    MIN(CASE WHEN cap.date_opened != '2020-01-01' THEN cap.date_opened ELSE NULL END)
        OVER (PARTITION BY cap.parent_case_id)                             AS min_clinic_date_opened,
    -- Additional values for search filters
    cap.current_status,
    cap.community_served,
    c.exclude_from_ccs                                                      AS clinic_exclude_from_ccs,
    c.case_id                                                               AS clinic_case_id,
    c.insurance                                                             AS clinic_insurance,
    c.language_services,
    c.accessibility                                                         AS clinic_accessibility,
    c.site_closed                                                           AS clinic_site_closed
FROM case_capacity cap
LEFT JOIN case_unit un ON contains(cap.unit_case_ids, un.case_id)
LEFT JOIN case_clinic c ON cap.parent_case_id = c.case_id
```

---

## Incoming Referrals

Use case: Fetches referral records joined to client demographics and referring clinic details. The LEFT JOIN on `case_client` means referrals without a matched client are still returned. The INNER JOIN on `case_clinic` means only referrals with a matched referring clinic are returned.
This allows for users to search across all referrals sent to their clinic, and display information about the client and referring facility associated with that referral

```sql
SELECT
    r.case_id,
    c.client_id                         AS client_id,
    c.age                               AS client_age,
    c.gender                            AS client_gender,
    r.client_type_of_care_display,
    r.client_reason_for_seeking_care,
    r.client_level_of_care_needed,
    r.referral_date,
    r.current_status,
    r.referrer_name,
    r.referring_clinic_case_id,
    clinic.case_name                    AS referring_clinic_case_name,
    r.destination_clinic_case_id,
    r.referral_ts,
    r.send_to_destination_clinic,
    r.date_opened,
    c.closed,
    c.case_type,
    c.central_registry,
    c.age_range                         AS client_age_range,
    c.type_of_care                      AS client_type_of_care
FROM case_referral r
LEFT JOIN case_client c ON r.parent_case_id = c.case_id
JOIN case_clinic clinic ON r.referring_clinic_case_id = clinic.case_id
```

---

## Table Descriptions

### `case_client`

Stores the core identity and status information for each client case. Each row represents a unique client, identified by a `case_id`.

| Column | Description |
|---|---|
| `case_id` | Unique identifier for the client case (primary key) |
| `first_name` | Client's first name |
| `middle_name` | Client's middle name |
| `last_name` | Client's last name |
| `dob` | Date of birth |
| `social_security_number` | Client's SSN |
| `medicaid_id` | Client's Medicaid identifier |
| `central_registry` | Central registry reference or flag |
| `current_status` | Current status of the case |

### `case_alias`

Stores alternative identity records associated with a client case. A single client may have multiple alias records (e.g. name changes, alternate IDs), making this a one-to-many child table of `case_client`.

| Column | Description |
|---|---|
| `case_id` | Unique identifier for the alias record (primary key) |
| `parent_case_id` | Foreign key reference to `case_client.case_id` (also referenced as `client_case_id` in joins) |
| `first_name` | Alias first name |
| `last_name` | Alias last name |
| `dob` | Alias date of birth |
| `medicaid_id` | Alias Medicaid identifier |
| `social_security_number` | Alias SSN |

### `case_service`

Stores service episode records associated with a client case. Each row represents a discrete service enrollment for a client. This table is an INNER JOIN target against `case_client`, meaning only clients with at least one service record will appear in queries that join these two tables.

| Column | Description |
|---|---|
| `parent_case_id` | Foreign key reference to `case_client.case_id` |
| `admission_date` | Date the client was admitted to the service |
| `discharge_date` | Date the client was discharged from the service |
| `clinic_case_id` | Clinic-specific case identifier for this service episode |
| `current_status` | Current status of the service record |

### `case_capacity`

Stores bed/capacity records for a clinic. Each row represents a capacity unit at a clinic, tracking availability and the population served. This is the driving table in capacity-related queries, joined out to clinic and unit details.

| Column | Description |
|---|---|
| `case_id` | Unique identifier for the capacity record (primary key) |
| `parent_case_id` | Foreign key reference to `case_clinic.case_id` |
| `unit_case_ids` | Array of unit case IDs associated with this capacity record (used in `contains()` join to `case_unit`) |
| `age_served` | Age group(s) served by this capacity record |
| `gender_served` | Gender(s) served by this capacity record |
| `open_beds` | Current number of open beds |
| `date_opened` | Date the capacity record was opened; used to derive the earliest active date per clinic (note: `2020-01-01` is treated as a sentinel/null value in this logic) |
| `current_status` | Current status of the capacity record |
| `community_served` | Community or population served |
| `view_more_info_smartlink_bed_tracker` | Smartlink to a bed tracker for additional capacity details |

### `case_unit`

Stores unit-level records within a clinic. A unit represents a sub-division of a clinic (e.g. a ward or program). Units are linked to capacity records via an array membership check rather than a direct foreign key.

| Column | Description |
|---|---|
| `case_id` | Unique identifier for the unit record (primary key) |
| `case_name` | Display name of the unit |

### `case_clinic`

Stores clinic-level reference data. Each row represents a physical or organizational clinic site. Clinic records are the parent of capacity records and provide the descriptive and geographic attributes used in search and display.

| Column | Description |
|---|---|
| `case_id` | Unique identifier for the clinic (primary key) |
| `display_name` | Human-readable name of the clinic |
| `insurance` | Insurance types accepted by the clinic |
| `phone_referrals` | Phone referral display information |
| `map_coordinates` | Geographic coordinates for map display |
| `address_full` | Full street address |
| `mental_health_settings` | Mental health setting types offered |
| `residential_services` | Residential service types offered |
| `language_services` | Language access services available |
| `accessibility` | Accessibility features available |
| `exclude_from_ccs` | Flag indicating whether the clinic should be excluded from CCS results |
| `site_closed` | Flag indicating whether the clinic site is closed |

### `case_referral`

Stores referral records linking a client to a referring clinic and a destination clinic. Each row represents a single referral event. This table is the driving table in referral queries, joined to `case_client` for client demographics and to `case_clinic` for referring clinic details.

| Column | Description |
|---|---|
| `case_id` | Unique identifier for the referral record (primary key) |
| `parent_case_id` | Foreign key reference to `case_client.case_id` |
| `referring_clinic_case_id` | Foreign key reference to `case_clinic.case_id` for the clinic initiating the referral |
| `destination_clinic_case_id` | Case ID of the clinic the client is being referred to |
| `client_type_of_care_display` | Display label for the type of care requested by the client |
| `client_reason_for_seeking_care` | Client's stated reason for seeking care |
| `client_level_of_care_needed` | Level of care determined to be needed for the client |
| `referral_date` | Date the referral was made |
| `referral_ts` | Timestamp of the referral event |
| `current_status` | Current status of the referral |
| `referrer_name` | Name of the individual who made the referral |
| `send_to_destination_clinic` | Flag or value indicating whether the referral has been sent to the destination clinic |
| `date_opened` | Date the referral record was opened |
