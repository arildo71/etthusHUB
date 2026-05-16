#!/usr/bin/env python3
"""Find Plejd site IDs for a given account. Uses pyplejd's cloud module."""
import sys, asyncio

async def main():
    if len(sys.argv) < 3:
        print("Usage: python get_site_id.py <email> <password>")
        return

    email = sys.argv[1]
    password = sys.argv[2]

    print(f"Looking up sites for {email}...")
    print()

    from pyplejd.cloud import PlejdCloudSite

    sites = await PlejdCloudSite.get_sites(email, password)
    
    if not sites:
        print("  No sites found.")
        return

    print("Sites found:")
    for site in sites:
        name = site.get('title', site.get('siteTitle', 'Unnamed'))
        site_id = site.get('siteId', site.get('objectId', '?'))
        devices = site.get('deviceCount', 0)
        print(f"  Name: {name}")
        print(f"  Site ID: {site_id}")
        print(f"  Devices: {devices}")
        print()

asyncio.run(main())
