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

### Filtering Logic

Here is the detailed breakdown of the filtering logic for **Search and Admit Client** from the **Central Registry** app.

Because this module queries a statewide/centralized patient registry, its filtering is designed to find patients not just by their primary demographics, but also by any alternate identities (aliases) they might have used in the past. In the normalized table structure, alias data is available as directly joined columns from `case_alias` (prefixed `alias_`), so filters can be expressed as standard `OR` conditions against those columns.

#### 1. Base Filtering (Always Applied)

These filters evaluate columns on the `case_client` table to ensure only valid registry patients are returned.

* **Registry Validation:**
    * **Column:** `c.central_registry`
    * **Logic:** `c.central_registry = 'yes'`
    * **Description:** Ensures the client is actually enrolled in the centralized database, keeping local/draft cases out of the statewide search.

* **Active Status:**
    * **Column:** `c.current_status`
    * **Logic:** `c.current_status != 'pending'`
    * **Description:** Excludes client profiles that are still in a "pending" state (e.g., they were started but never finished or are awaiting deduplication/approval).

#### 2. Dynamic User Filters

When a user types into the search fields, the query checks whether the value matches the primary `case_client` columns **OR** the corresponding `case_alias` columns in the same row. Because aliases are left-joined, rows where no alias exists will have `NULL` alias columns and will still match on the primary columns alone.

* **First Name & Last Name (User Input):**
    * **Columns:** `c.first_name`, `c.last_name`, `a.first_name`, `a.last_name`
    * **Logic:** `(fuzzy-match(c.first_name, [input]) OR phonetic-match(c.first_name, [input])) OR (fuzzy-match(a.first_name, [input]) OR phonetic-match(a.first_name, [input]))` *(The exact same logic structure is repeated for `last_name`)*
    * **Description:** Instead of requiring an exact spelling match, the filter casts a wide net to prevent creating duplicate patients. It checks both the primary client columns and the joined alias columns for fuzzy or phonetic matches in a single pass.

* **Date of Birth (User Input & Fuzzy Matching):**
    * **Columns:** `c.dob`, `a.alias_dob`
    * **Logic:** `IF(fuzzy_match_dob = 'yes', fuzzy-date(c.dob, [input]) OR fuzzy-date(a.alias_dob, [input]), c.dob = [input] OR a.alias_dob = [input])`
    * **Description:** Evaluates the `fuzzy_match_dob` toggle. If unchecked, performs a strict equality check against both the primary and alias DOB columns. If toggled on, applies `fuzzy-date()` to both columns, catching common typographical permutations such as swapped month/day or reversed year digits.

* **Social Security Number & Medicaid ID (User Inputs):**
    * **Columns:** `c.social_security_number`, `a.alias_ssn`, `c.medicaid_id`, `a.alias_medicaid`
    * **Logic:** `c.social_security_number = [input] OR a.alias_ssn = [input]` *(Same pattern for `medicaid_id` / `alias_medicaid`)*
    * **Description:** Cross-references the input against both the primary and alias identifier columns in the same row.

* **Middle Name (User Input):**
    * **Column:** `c.middle_name`
    * **Logic:** `c.middle_name = [input]`
    * **Description:** Checks only the primary client record. Middle names are not tracked in `case_alias`, so no alias column check is needed here.

* **Case ID (User Input):**
    * **Columns:** `c.case_id`, `a.alias_case_id`
    * **Logic:** `c.case_id = [input] OR a.alias_case_id = [input]`
    * **Description:** Allows a direct lookup by system ID, checking both the primary client ID and the joined alias case ID column.

#### 3. Special Validation Filters

* **Consent Collected (User Input):**
    * **Column:** `c.consent_collected`
    * **Logic:** `c.consent_collected = [input]`
    * **Description:** Evaluates the `consent_collected` flag on the primary client record. In highly secure central registries, searching for certain clients may be restricted unless the user explicitly confirms they have collected ROI (Release of Information) or consent from the patient.

---

## Search My Clients

Extends the client/alias query with service episode data. The INNER JOIN on `case_service` means only clients with at least one service record are returned. Aliases are still left-joined, so a client without aliases will not be dropped. This allows for users to search for clients based on whether there is a service case associated with one of the clinics for the user's locations.

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

### Filtering Logic

Here is the detailed breakdown of the filtering logic for **Search My Clients** from the **Central Registry** app.

While Search and Admit searches the entire statewide registry, Search My Clients is specifically designed so users can search within their own clinic's patient roster. Service episode data is available as directly joined columns from `case_service` (prefixed `service_`), so filters against admission and service properties are expressed as standard column checks.

#### 1. Base Filtering (Always Applied)

These filters automatically restrict the result set to only clients relevant to the logged-in user.

* **Facility Ownership (The "My" in My Clients):**
    * **Column:** `s.service_clinic_case_id`
    * **Logic:** `s.service_clinic_case_id = [user's_clinic_id]`
    * **Description:** This is the core security filter. It restricts results to rows where the joined service record's `clinic_case_id` exactly matches the facility the user is currently logged into. Because `case_service` is INNER JOINed, clients with no service record at any clinic are already excluded.

* **Registry Validation:**
    * **Column:** `c.central_registry`
    * **Logic:** `c.central_registry = 'yes'`
    * **Description:** Ensures the root client record is officially part of the central registry.

#### 2. Dynamic User Filters: Service Columns

Because the user is searching their specific admissions, certain search fields evaluate columns from the joined `case_service` table.

* **Current Status (User Input):**
    * **Column:** `s.service_current_status`
    * **Logic:** `s.service_current_status = [input] AND s.service_clinic_case_id = [user's_clinic_id]`
    * **Description:** Allows the user to filter their roster by admission status (e.g., active, discharged). The clinic ID condition ensures the status being checked belongs to the episode of care at their clinic, not a concurrent admission at a different clinic.

* **Admission Date & Discharge Date (User Inputs):**
    * **Columns:** `s.service_admission_date`, `s.service_discharge_date`
    * **Logic:** `s.service_admission_date >= [start_date] AND s.service_admission_date <= [end_date]`
    * **Description:** Filters the patient list by when they were admitted or discharged, evaluated against the service columns corresponding to the user's clinic.

#### 3. Dynamic User Filters: Demographics

Users need to be able to find their own patients even if the patient's name or ID has changed over time. The query checks the primary `case_client` columns **OR** the corresponding `case_alias` columns in the same row.

* **First Name & Last Name (User Input):**
    * **Columns:** `c.first_name`, `c.last_name`, `a.first_name`, `a.last_name`
    * **Logic:** `(fuzzy-match(c.first_name, [input]) OR phonetic-match(c.first_name, [input])) OR (fuzzy-match(a.first_name, [input]) OR phonetic-match(a.first_name, [input]))` *(The exact same logic structure is repeated for `last_name`)*
    * **Description:** Checks both the primary client columns and the joined alias columns for fuzzy or phonetic matches, casting a wide net to locate patients whose names may have minor typos or sound-alike variations.

* **Date of Birth (User Input & Fuzzy Matching):**
    * **Columns:** `c.dob`, `a.alias_dob`
    * **Logic:** `IF(fuzzy_match_dob = 'yes', fuzzy-date(c.dob, [input]) OR fuzzy-date(a.alias_dob, [input]), c.dob = [input] OR a.alias_dob = [input])`
    * **Description:** Evaluates the `fuzzy_match_dob` toggle. If unchecked, performs a strict equality check against both the primary and alias DOB columns. If toggled on, applies `fuzzy-date()` to both columns to catch common typographical permutations.

* **Social Security Number & Medicaid ID (User Inputs):**
    * **Columns:** `c.social_security_number`, `a.alias_social_security_number`, `c.medicaid_id`, `a.alias_medicaid_id`
    * **Logic:** `c.social_security_number = [input] OR a.alias_social_security_number = [input]` *(Same pattern for `medicaid_id` / `alias_medicaid_id`)*
    * **Description:** Cross-references the input against both the primary and alias identifier columns in the same row.

* **Case ID (User Input):**
    * **Columns:** `c.case_id`, `a.alias_case_id`
    * **Logic:** `c.case_id = [input] OR a.alias_case_id = [input]`
    * **Description:** A direct lookup using the system's exact case ID, checking both the primary client ID and the joined alias case ID column.

---

## Search Beds

Fetches capacity records enriched with clinic details and unit names. The windowed `MIN()` on `date_opened` derives the earliest active date per clinic, with `2020-01-01` treated as a sentinel null value. Units are joined via an array membership check rather than a direct foreign key. This allows for users to search for open beds (represented by capacity cases) and also to see relevant information for that capacity case's unit and parent clinic.

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

### Filtering Logic

Here is a detailed breakdown of exactly how each filter is executed for **Search Beds**. Because Search Beds searches for `case_capacity` records but users are conceptually searching for facilities, filtering is split between columns on the `case_capacity` table and columns on the joined `case_clinic` table (prefixed `clinic_`).

#### 1. Direct Checks on `case_capacity` Columns

* **Active Capacity Record:**
    * **Column:** `cap.current_status`
    * **Logic:** `cap.current_status != 'closed'`
    * **Description:** Ensures the system only returns capacity records that haven't been archived or closed.

* **Only Open Beds (User Input):**
    * **Column:** `cap.open_beds`
    * **Logic:** `cap.open_beds > 0`
    * **Description:** If the user checks the "Only Open Beds" box, filters out any capacity row where `open_beds` is 0 or null.

* **Age (User Input):**
    * **Column:** `cap.age_served`
    * **Logic:** `selected(cap.age_served, [user_input])`
    * **Description:** Checks if the user's selected age group is present within the `age_served` value.

* **Gender (User Input):**
    * **Column:** `cap.gender_served`
    * **Logic:** `selected(cap.gender_served, [user_input]) OR selected(cap.gender_served, 'no_gender_restrictions')`
    * **Description:** Evaluates if the user's selected gender matches `gender_served`, and also includes any capacity row flagged as having no gender restrictions.

* **Community (User Input):**
    * **Column:** `cap.community_served`
    * **Logic:** `selected-all(cap.community_served, [user_inputs])`
    * **Description:** Ensures that if a user searches for multiple community attributes, the capacity row must support all of them within `community_served`.

* **Justice Involvement (User Input):**
    * **Column:** `cap.community_served`
    * **Logic:** `selected(cap.community_served, 'referred_from_court-judicial_system')`
    * **Description:** A specific toggle that checks for the court/judicial system flag within the `community_served` value.

#### 2. Checks on Joined `case_clinic` Columns

The following filters are applied against the clinic columns available in the result set from the LEFT JOIN on `case_clinic`.

* **Base Clinic Status:**
    * **Columns:** `c.clinic_exclude_from_ccs`, `c.clinic_site_closed`
    * **Logic:** `c.current_status != 'closed' AND c.clinic_exclude_from_ccs != 'yes'`
    * **Description:** Ensures the joined clinic is active and has not been explicitly hidden from the Client Care Search directory.

* **Base Clinic Services (Required):**
    * **Columns:** `c.clinic_mental_health_settings`, `c.clinic_residential_services`
    * **Logic:** `selected-any(c.clinic_mental_health_settings, [list_of_valid_mh_codes]) OR selected-any(c.clinic_residential_services, [list_of_valid_res_codes])`
    * **Description:** The clinic must offer at least one valid, recognized mental health or residential service to be included in search results.

* **Site Closed Grace Period:**
    * **Column:** `c.clinic_site_closed`
    * **Logic:** `c.clinic_site_closed != 'yes' OR (c.clinic_site_closed = 'yes' AND c.site_closed_date >= [30 days ago])`
    * **Description:** The clinic must not be closed. If it is marked as closed, its `site_closed_date` must be within the last 30 days.

* **Facility Name (User Input):**
    * **Column:** `c.clinic_case_id`
    * **Logic:** `selected(c.clinic_case_id, [user_input_clinic_ids])`
    * **Description:** If the user searches for specific facilities by name, checks whether the joined clinic's `case_id` matches any of the selected clinic IDs.

* **Location & Distance (User Input):**
    * **Column:** `c.clinic_map_coordinates`
    * **Logic:** `within-distance(c.clinic_map_coordinates, [user_geopoint], [user_distance_or_50], 'miles')`
    * **Description:** Checks if the clinic's `map_coordinates` falls within a certain radius of the user's provided geopoint. Defaults to a 50-mile radius if no distance is specified.

* **Facility Category (User Input):**
    * **Columns:** `c.clinic_residential_services`, `c.clinic_mental_health_settings`
    * **Logic:** `c.clinic_residential_services != ''` (Substance Use), `c.clinic_mental_health_settings != ''` (Mental Health), or both.
    * **Description:** Filters facilities by overarching care category by ensuring the corresponding service columns contain data.

* **Dropdown/Multiselect Traits (User Inputs):**
    * **Columns:** `c.clinic_insurance`, `c.language_services`, `c.clinic_accessibility`, `c.clinic_residential_services`
    * **Logic:** `selected(c.clinic_insurance, [input])`, `selected(c.language_services, [input])`, `selected(c.clinic_accessibility, [input])`, `selected(c.clinic_residential_services, [input])`
    * **Description:** Evaluates whether specific user-selected values exist within the clinic's insurance, language, accessibility, or residential service columns.

* **Voluntary Treatment (User Input):**
    * **Column:** `c.clinic_mental_health_settings`
    * **Logic:** `selected(c.clinic_mental_health_settings, '72_hour_treatment_and_evaluation')`
    * **Description:** If the user notes the client is involuntary, forces the clinic to specifically have the 72-hour treatment setting.

* **My Favorites (User Input):**
    * **Column:** `c.clinic_case_id`
    * **Logic:** `selected(c.clinic_case_id, instance('casedb')/casedb/case[@case_type='commcare-user'][...]/favorite_clinic_case_ids)`
    * **Description:** Loads the user's own profile, reads their saved list of `favorite_clinic_case_ids`, and checks whether the joined clinic's `case_id` appears in that list.

---

## Incoming Referrals

Fetches referral records joined to client demographics and referring clinic details. The LEFT JOIN on `case_client` means referrals without a matched client are still returned. The INNER JOIN on `case_clinic` means only referrals with a matched referring clinic are returned. This allows for users to search across all referrals sent to their clinic, and display information about the client and referring facility associated with that referral.

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

### Filtering Logic

Here is the detailed breakdown of how the filtering is executed for **Incoming Referrals**. In this module, the search is performed against `case_referral` rows. Filters against patient demographics are expressed as standard column checks against the left-joined `case_client` columns (prefixed `client_`).

#### 1. Direct Checks on `case_referral` Columns

* **Platform Routing & Ownership (Base Filter):**
    * **Columns:** `r.send_to_destination_clinic`, `r.destination_clinic_case_id`
    * **Logic:** `r.send_to_destination_clinic != 'no' AND selected(r.destination_clinic_case_id, [list_of_user's_clinic_ids])`
    * **Description:** First, ensures the referral is meant to be processed inside the app (excluding off-platform manual referrals). Second, checks whether the referral's `destination_clinic_case_id` matches one of the clinics the user actually works at.

* **Referral Status (User Input or Default):**
    * **Column:** `r.current_status`
    * **Logic:** If the user selects statuses: `selected(r.current_status, [user_inputs])`. Default: `r.current_status = 'open' OR r.current_status = 'info_requested'`
    * **Description:** By default, only shows referrals that are actively awaiting a decision or waiting on more information. If a user applies the status filter, it overrides the default to show whichever specific statuses they select.

* **Date Received (User Input):**
    * **Column:** `r.date_opened`
    * **Logic:** `r.date_opened >= [start_date] AND r.date_opened <= [end_date]`
    * **Description:** Filters referrals to those whose `date_opened` falls within the user-specified date range.

#### 2. Checks on Joined `case_client` Columns

The following filters are applied against the client columns available in the result set from the LEFT JOIN on `case_client`.

* **Base Client Validation (Always Applied):**
    * **Columns:** `c.closed`, `c.case_type`, `c.central_registry`
    * **Logic:** `c.closed = 'no' AND c.case_type = 'client' AND c.central_registry = 'no'`
    * **Description:** Every referral shown must belong to an active, open client record. Clients flagged in the `central_registry` are excluded to ensure registry management cases don't appear in the facility's active inbox.

* **Age Range (User Input):**
    * **Column:** `c.client_age_range`
    * **Logic:** `c.client_age_range = [user_input]`
    * **Description:** Checks whether the client's calculated `age_range` value (e.g., `adults`, `minors_adolescents`) exactly matches the user's dropdown selection.

* **Gender (User Input):**
    * **Column:** `c.client_gender`
    * **Logic:** `selected(c.client_gender, [user_input]) OR selected(c.client_gender, 'no_gender_restrictions')`
    * **Description:** Checks whether the client's `gender` column contains the user's selection, and also includes records where gender restrictions do not apply.

* **Type of Care (User Input):**
    * **Column:** `c.client_type_of_care`
    * **Logic:** `c.client_type_of_care = [user_input]`
    * **Description:** Ensures the client's `type_of_care` value (e.g., mental health, substance use) exactly matches the category the user is filtering by.

* **Client ID (User Input):**
    * **Column:** `c.client_id`
    * **Logic:** `c.client_id = [user_input]`
    * **Description:** Allows a direct lookup by the client's exact 8-character alphanumeric `client_id`.

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
