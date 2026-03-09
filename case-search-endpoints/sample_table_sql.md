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
### Filtering Logic
Here is a detailed breakdown of exactly how each filter is executed under the hood for **Search Beds**.

Because Search Beds searches for `capacity` (bed) cases but users are conceptually searching for "facilities," the filtering is split between checks done directly on the `capacity` case and checks done on the parent `clinic` case using a special related-case function.

#### 1. Direct Checks on the `capacity` Case

These filters evaluate the properties living directly on the bed capacity record.

* **Active Capacity Record:**
    * **Function:** Simple inequality check.
    * **Logic:** `current_status != 'closed'`
    * **Description:** Ensures the system only returns capacity records that haven't been archived or closed.


* **Only Open Beds (User Input):**
    * **Function:** Simple greater-than mathematical check.
    * **Logic:** `open_beds > 0`
    * **Description:** If the user checks the "Only Open Beds" box, the query filters out any capacity case where the `open_beds` integer is 0 or empty.


* **Age (User Input):**
    *  **Function:** `selected()` (CommCare's function for checking if a value exists within a space-separated list).
    * **Logic:** `selected(age_served, [user_input])`
    * **Description:** Checks if the user's selected age group is present within the capacity's `age_served` property.


* **Gender (User Input):**
    *  **Function:** `selected()` with an `or` condition.
    * **Logic:** `selected(gender_served, [user_input]) or selected(gender_served, 'no_gender_restrictions')`
    * **Description:** Evaluates if the user's selected gender matches the capacity's `gender_served` property, *but* automatically includes any capacity case where `gender_served` is flagged as having `'no_gender_restrictions'`.


* **Community (User Input):**
    * **Function:** `selected-all()` (Checks if *every* item in the user's input list exists in the case property).
    * **Logic:** `selected-all(community_served, [user_inputs])`
    * **Description:** Ensures that if a user searches for multiple specific community attributes, the capacity case must support *all* of them within its `community_served` property.


* **Justice Involvement (User Input):**
    * **Function:** `selected()`
    * **Logic:** `selected(community_served, 'referred_from_court-judicial_system')`
    * **Description:** A specific toggle that looks inside the `community_served` property for the exact court/judicial system flag.


#### 2. Checks on the Parent `clinic` Case

To filter capacity cases based on the facility they belong to, the query uses the **`ancestor-exists()`** function. This function tells the system: *"Only return this capacity case if its parent clinic meets the following conditions."* Inside the `ancestor-exists(parent, ...)` wrapper, the following checks are performed on the clinic:

* **Base Clinic Status:** 
    * **Function:** Simple equality and inequality checks.
    * **Logic:** `@status = 'open' and current_status != 'closed' and exclude_from_ccs != 'yes'`
    * **Description:** Ensures the parent clinic is open, active, and has not been explicitly hidden from the Client Care Search directory.


* **Base Clinic Services (Required):**
    * **Function:** `selected-any()` (Checks if *at least one* item in a list matches).
    * **Logic:** `selected-any(mental_health_settings, '[list_of_valid_mh_codes]') or selected-any(residential_services, '[list_of_valid_res_codes]')`
    * **Description:** The clinic must offer at least one valid, recognized mental health or residential service to be included in the search results.


* **Site Closed Grace Period:** * **Function:** Compound equality and mathematical date check.
    * **Logic:** `site_closed != 'yes' or (site_closed = 'yes' and site_closed_date >= [30 days ago])`
    * **Description:** The clinic must not be closed. If it *is* marked as closed, its `site_closed_date` must be mathematically greater than or equal to 30 days ago.


* **Facility Name (User Input):** * **Function:** `selected()` (used here to compare IDs).
    * **Logic:** `selected(@case_id, [user_input_clinic_ids])`
    * **Description:** If the user searches for specific facilities by name, the system looks up those clinics' case IDs and checks if the parent clinic's `@case_id` matches any of them.


* **Location & Distance (User Input):**
    * **Function:** `within-distance()` (A specialized geospatial search function).
    * **Logic:** `within-distance("map_coordinates", "[user_geopoint]", "[user_distance_or_50]", "miles")`
    * **Description:** Checks if the clinic's `map_coordinates` property falls within a certain radius of the user's provided geopoint. If the user doesn't specify a distance, it defaults to a 50-mile radius.


* **Facility Category (User Input):**
    * **Function:** Non-empty string checks (`!= ''`).
    * **Logic:** Depending on the user's choice, it checks if `residential_services != ''` (Substance Use), `mental_health_settings != ''` (Mental Health), or both properties are not empty.
    * **Description:** Filters facilities based on the overarching category of care by ensuring the corresponding service properties actually contain data.


* **Dropdown/Multiselect Traits (User Inputs):**
    * **Function:** `selected()`
    * **Logic:** `selected(insurance, [input])`, `selected(language_services, [input])`, `selected(accessibility, [input])`, `selected(residential_services, [input])` (for ASAM levels and residential specific searches).
    * **Description:** Evaluates if the specific values checked by the user exist within the clinic's space-separated properties for insurance, languages, accommodations, or specific residential services.


* **Voluntary Treatment (User Input):**
    * **Function:** `selected()`
    * **Logic:** `selected(mental_health_settings, '72_hour_treatment_and_evaluation')`
    * **Description:** If the user notes the client is involuntary, it forces the parent clinic to specifically have the 72-hour treatment setting.


* **My Favorites (User Input):**
    * **Function:** `selected()` evaluating against a dynamically loaded session variable.
    * **Logic:** `selected(@case_id, instance('casedb')/casedb/case[@case_type='commcare-user'][...]/favorite_clinic_case_ids)`
    * **Description:** If the user clicks the "Favorites" filter, the system loads the user's own `commcare-user` profile, reads their saved list of `favorite_clinic_case_ids`, and checks if the parent clinic's `@case_id` is in that list.
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
### Filter Logic
Here is the detailed breakdown of how the filtering is executed for **Module 9 (Incoming Referrals)**.

In this module, the search is performed against **`referral`** cases. However, because referrals are intrinsically linked to the person receiving care, several filters use the `ancestor-exists()` function to query the properties of the parent **`client`** case.

#### 1. Direct Checks on the `referral` Case

These filters evaluate the properties living directly on the incoming referral record.

* **Platform Routing & Ownership (Base Filter):**
    * **Function:** Inequality check (`!=`) paired with a dynamic `selected()` function.
    * **Logic:** `send_to_destination_clinic != "no" and selected(destination_clinic_case_id, [list_of_users_clinic_ids])`
    * **Description:** First, it ensures the referral is meant to be processed inside the app (excluding off-platform manual referrals). Second, it dynamically looks up all the clinic cases tied to the user's assigned locations, checking if the referral's `destination_clinic_case_id` matches one of the clinics the user actually works at.


* **Referral Status (User Input or Default):**
    * **Function:** `selected()` check for user inputs, or a compound equality check for the default state.
    * **Logic:** If the user selects statuses, it evaluates `selected(current_status, '[user_inputs]')`. If left blank, it defaults to `current_status = "open" or current_status = "info_requested"`.
    * **Description:** By default, the inbox keeps out the clutter by only showing referrals that are actively awaiting a decision or waiting on more information. If a user uses the "Current Status" filter, it overrides the default to show whatever specific statuses they select (e.g., rejected, closed).


* **Date Received (User Input):**
    * **Function:** Greater-than-or-equal-to (`>=`) and less-than-or-equal-to (`<=`) mathematical date checks, utilizing the `substr()` string-extraction function.
    * **Logic:** `date_opened >= "[start_date]" and date_opened <= "[end_date]"`
    * **Description:** The user-facing search field is a date-range widget. The system extracts the start and end dates from that widget and filters out any referrals where the `date_opened` does not fall exactly within or on those boundaries.


#### 2. Checks on the Parent `client` Case

To filter incoming referrals based on the traits of the actual patient, the query wraps the following logic inside the **`ancestor-exists()`** function. This function dictates: *"Only return this referral if the parent client case meets the following conditions."*

* **Base Client Validation (Always Applied):**
    * **Function:** Simple equality checks.
    * **Logic:** `@status = "open" and @case_type = "client" and central_registry = "no"`
    * **Description:** Every referral shown must belong to an active, open client case. Furthermore, it explicitly filters out any clients flagged in the `central_registry` (ensuring registry management cases don't bleed into the facility's active inbox).


* **Age Range (User Input):**
    * **Function:** Simple equality check.
    * **Logic:** `age_range = '[user_input]'`
    * **Description:** If the user filters by age, it checks if the parent client's calculated `age_range` text property (e.g., "adults", "minors_adolescents") exactly matches the dropdown selection.


* **Gender (User Input):**
    * **Function:** `selected()` with an `or` condition.
    * **Logic:** `selected(gender, '[user_input]') or selected(gender, 'no_gender_restrictions')`
    * **Description:** Checks if the parent client's `gender` property contains the user's selection. Similar to the bed search, it includes a fallback to safely return cases where gender restrictions do not apply.


* **Type of Care (User Input):**
    * **Function:** Simple equality check.
    * **Logic:** `type_of_care = '[user_input]'`
    * **Description:** Ensures the parent client's overarching `type_of_care` property (e.g., mental health, substance use) exactly matches the category the user is searching for.


* **Client ID (User Input):**
    * **Function:** Simple equality check.
    * **Logic:** `client_id = "[user_input]"`
    * **Description:** Allows the facility user to search for a specific referral by typing in the parent client's exact, 8-character alphanumeric `client_id`.

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
