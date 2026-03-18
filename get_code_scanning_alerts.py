"""
https://docs.github.com/en/enterprise-cloud@latest/rest/code-scanning/code-scanning?apiVersion=2022-11-28
"""
import csv
import sys
from getpass import getpass
from pprint import pprint

import requests

REPOS = ['commcare-hq', 'vellum', 'commcare-cloud']
SEVERITIES = ['critical', 'high']
OUTPUT_FILE = 'code_scanning_alerts.csv'
CSV_COLUMNS = ['repository', 'alert_level', 'url', 'description', 'location', 'details']


class CodeScanningAPI:
    def __init__(self, repo, token):
        self.repo = repo
        self.token = token
        self.base_url = f"https://api.github.com/repos/dimagi/{repo}/code-scanning"

    def _get(self, path, params=None):
        # Note, this does not (yet) paginate. We shouldn't need to anyways
        url = f"{self.base_url}/{path}"
        response = requests.get(url, params=params or {}, headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        if response.status_code != 200:
            print(f"Error, got a {response.status_code} response.")
            pprint(response.json())
            sys.exit(1)
        return response.json()

    def list_alerts(self):
        rows = []
        for severity in SEVERITIES:
            alerts = self._get('alerts', params={
                'ref': 'master',
                'state': 'open',
                'severity': severity,
            })
            print(f"'{severity}' level alerts: {len(alerts)}")
            for alert in alerts:
                # print(f"  {alert['html_url']}: {alert['rule']['description']}")

                location = alert.get('most_recent_instance', {}).get('location', {})
                path = location.get('path', '')
                line = location.get('start_line')
                location_str = f"{path}:{line}" if path and line else path

                rule = alert.get('rule', {})
                rows.append({
                    'repository': self.repo,
                    'alert_level': rule.get('security_severity_level', rule.get('severity', '')),
                    'url': alert.get('html_url', ''),
                    'description': rule.get('description', ''),
                    'location': location_str,
                    'details': rule.get('full_description', ''),
                })
        return rows

    def show_last_analyses(self):
        last_analyses = self._get('analyses', params={
            'ref': 'master',
            'per_page': 3,
        })
        seen = set()
        for analysis in last_analyses:
            tool_name = analysis['tool']['name']
            if tool_name not in seen:
                print(f"Last analysis: {analysis['created_at']}")
                print(f"  tool: {tool_name} {analysis['tool']['version']}")
                print(f"  rules_count: {analysis['rules_count']}")
                print(f"  results_count: {analysis['results_count']}")
                seen.add(tool_name)


if __name__ == '__main__':
    token = getpass("Enter your github access token: ")
    all_rows = []
    for repo in REPOS:
        print("\n")
        print(repo)
        print("================")
        api = CodeScanningAPI(repo, token)
        api.show_last_analyses()
        print("\n")
        all_rows.extend(api.list_alerts())

    with open(OUTPUT_FILE, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"\nWrote {len(all_rows)} alerts to {OUTPUT_FILE}")
