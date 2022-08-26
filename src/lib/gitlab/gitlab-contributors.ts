import {
  GitlabTarget,
  Username,
  Contributor,
  ContributorMap,
  Integration,
} from '../types';
import { Commits, Project, Group, User, Diff } from './types';
import { fetchAllPages } from './utils';
import * as debugLib from 'debug';
import { genericRepo, genericTarget } from '../common/utils';
import { stringify } from 'csv-stringify/sync';
import { string } from 'yargs';
import { writeFile } from 'fs';

const gitlabDefaultUrl = 'https://gitlab.com/';
const debug = debugLib('snyk:gitlab-count');

export const fetchGitlabContributors = async (
  gitlabInfo: GitlabTarget,
  threeMonthsDate: string,
): Promise<ContributorMap> => {
  const contributorsMap = new Map<Username, Contributor>();


  const listOfExtensionsEncountered = new Set<string>()

  // email to map of extension + count
  const filesTouched = new Map<string, Map<string, number>>();

  try {
    let projectList: Project[] = [];
    // In Gitlab there's no need to provide a group for fetching project details, the project's path/namespace is enough
    if (gitlabInfo.project) {
      debug('Counting contributors for single project');
      projectList.push({
        path_with_namespace: gitlabInfo.project,
      });
    } else if (gitlabInfo.groups && !gitlabInfo.project) {
      let groupsList: Group[] = [];
      for (let i = 0; i < gitlabInfo.groups.length; i++) {
        groupsList = groupsList.concat(
          await findGroupPaths(
            gitlabInfo.url ? gitlabInfo.url : gitlabDefaultUrl,
            gitlabInfo.token,
            gitlabInfo.groups[i],
          ),
        );
      }
      gitlabInfo.groups = [];
      for (let j = 0; j < groupsList.length; j++) {
        gitlabInfo.groups.push(
          encodeURIComponent(groupsList[j].full_path.toString()),
        );
      }
      projectList = projectList.concat(
        await fetchGitlabProjects(
          gitlabInfo.url ? gitlabInfo.url : gitlabDefaultUrl,
          gitlabInfo,
        ),
      );
      debug(`Found ${groupsList.length} Groups`);
    } else {
      // Otherwise retrieve all projects (for given groups or all projects)
      projectList = projectList.concat(
        await fetchGitlabProjects(
          gitlabInfo.url ? gitlabInfo.url : gitlabDefaultUrl,
          gitlabInfo,
        ),
      );
    }
    debug(`Found ${projectList.length} Projects`);

    for (let i = 0; i < projectList.length; i++) {
      await fetchGitlabContributorsForProject(
        gitlabInfo.url ? gitlabInfo.url : gitlabDefaultUrl,
        gitlabInfo,
        projectList[i],
        contributorsMap,
        listOfExtensionsEncountered,
        filesTouched,
        threeMonthsDate,
      );
    }


    let csvMap: string[][] = []

    let header = ['author']
    for (const extension of listOfExtensionsEncountered) {
      header.push(extension)
    }
    csvMap.push(header)

    for (const author of filesTouched.keys()) {
      const touched = filesTouched.get(author)

      if (touched == undefined) {
        continue
      }

      let row = [author]
      for (const extension of listOfExtensionsEncountered) {
        row.push((touched.get(extension) ?? 0).toString())
      }
      csvMap.push(row)
    }

    writeFile('contributor-breakdown.csv', stringify(csvMap), err => {
      if (err) {
        debug('Failed to write contributor breakdown CSV.\n' + err)
        console.log(
          'Failed to write contributor-breakdown.csv. Try running with `DEBUG=snyk* snyk-contributor`',
        );
      }
    })
    // console.log()
  } catch (err) {
    debug('Failed to retrieve contributors from Gitlab.\n' + err);
    console.log(
      'Failed to retrieve contributors from Gitlab. Try running with `DEBUG=snyk* snyk-contributor`',
    );
  }
  debug(contributorsMap);
  return new Map([...contributorsMap.entries()].sort());
};

export const fetchGitlabContributorsForProject = async (
  url: string,
  gitlabInfo: GitlabTarget,
  project: Project,
  contributorsMap: ContributorMap,
  discoveredExtensions: Set<string>,
  filesTouched: Map<string, Map<string, number>>,
  threeMonthsDate: string,
): Promise<void> => {
  try {
    debug(
      `Fetching single project/repo contributor from Gitlab. Project ${project.path_with_namespace} - ID ${project.id}\n`,
    );
    const encodedProjectPath = encodeURIComponent(project.path_with_namespace);
    const response = (await fetchAllPages(
      `${url}/api/v4/projects/${encodedProjectPath}/repository/commits?since=${threeMonthsDate}&per_page=100`,
      gitlabInfo.token,
      project.id,
    )) as Commits[];


    for (let i = 0; i < response.length; i++) {
      const commit = response[i];

      let contributionsCount = 1;
      let reposContributedTo = [
        `${project.path_with_namespace || project.id}(${project.visibility})`,
      ];

      if (
        contributorsMap &&
        (contributorsMap.has(commit.author_name) ||
          contributorsMap.has(commit.author_email))
      ) {
        contributionsCount = contributorsMap.get(commit.author_email)
          ?.contributionsCount
          ? contributorsMap.get(commit.author_email)!.contributionsCount
          : contributorsMap.get(commit.author_name)?.contributionsCount || 0;
        contributionsCount++;

        reposContributedTo = contributorsMap.get(commit.author_email)
          ?.reposContributedTo
          ? contributorsMap.get(commit.author_email)!.reposContributedTo
          : contributorsMap.get(commit.author_name)?.reposContributedTo || [];
        if (
          !reposContributedTo.includes(
            `${project.path_with_namespace || project.id}(${project.visibility
            })`,
          )
        ) {
          // Dedupping repo list here
          reposContributedTo.push(
            `${project.path_with_namespace || project.id}(${project.visibility
            })`,
          );
        }
      }
      const isDuplicateName = await changeDuplicateAuthorNames(
        commit.author_name,
        commit.author_email,
        contributorsMap,
      );
      if (
        !commit.author_email.endsWith('@users.noreply.github.com') &&
        commit.author_email != 'snyk-bot@snyk.io'
      ) {
        const touched = filesTouched.get(commit.author_email) ?? new Map<string, number>();

        contributorsMap.set(isDuplicateName, {
          email: commit.author_email,
          contributionsCount: contributionsCount,
          reposContributedTo: reposContributedTo,
        });

        const diffs = (await fetchAllPages(
          `${url}/api/v4/projects/${encodedProjectPath}/repository/commits/${commit.id}/diff`,
          gitlabInfo.token,
          `${project.id}/${commit.id}/diff`,
        )) as Diff[];

        for (const diff of diffs) {
          // path/to/file.type
          let extension = diff.old_path.split('.').pop()
          if (extension === undefined) {
            // path/to/file
            extension = diff.old_path.split('/').pop()
            if (extension === undefined) {
              // file
              extension = diff.old_path
            }
          }

          discoveredExtensions.add(extension)

          const count = touched.get(extension) ?? 0
          touched.set(extension, count + 1)
        }

        filesTouched.set(commit.author_email, touched)
      }
    }

  } catch (err) {
    debug('Failed to retrieve commits from Gitlab.\n' + err);
    console.log(
      'Failed to retrieve commits from Gitlab. Try running with `DEBUG=snyk* snyk-contributor`',
    );
  }

};

const changeDuplicateAuthorNames = async (
  name: string,
  email: string,
  contributorMap: ContributorMap,
): Promise<string> => {
  for (const [username, contributor] of contributorMap) {
    if (username == name && email != contributor.email) {
      return `${name}(duplicate)`;
    }
  }
  return name;
};

export const fetchGitlabProjects = async (
  host: string,
  gitlabInfo: GitlabTarget,
): Promise<Project[]> => {
  const projectList: Project[] = [];
  const user = (await fetchAllPages(
    `${host}/api/v4/user`,
    gitlabInfo.token,
    'User',
  )) as User[];
  const fullUrlSet: string[] = !gitlabInfo.groups
    ? [
      host.includes('gitlab.com')
        ? '/api/v4/projects?per_page=100&membership=true'
        : '/api/v4/projects?per_page=100',
    ]
    : gitlabInfo.groups.map(
      (group) => `/api/v4/groups/${group}/projects?per_page=100`,
    );
  if (gitlabInfo.groups) {
    fullUrlSet.push(`/api/v4/users/${user[0].id}/projects?per_page=100`);
  }
  try {
    for (let i = 0; i < fullUrlSet.length; i++) {
      const projects = (await fetchAllPages(
        host + fullUrlSet[i],
        gitlabInfo.token,
        'Projects',
      )) as Project[];
      projects.map(
        (project: {
          path_with_namespace: string;
          id?: string;
          visibility?: string;
          default_branch?: string;
        }) => {
          const { path_with_namespace, id } = project;
          if (path_with_namespace && id) {
            projectList.push({
              id: project.id,
              path_with_namespace: project.path_with_namespace,
              visibility: project.visibility,
              default_branch: project.default_branch,
            });
          }
        },
      );
    }
  } catch (err) {
    debug('Failed to retrieve project list from Gitlab.\n' + err);
    console.log(
      'Failed to retrieve project list from Gitlab. Try running with `DEBUG=snyk* snyk-contributor`',
    );
  }
  return projectList;
};

export const findGroupPaths = async (
  host: string,
  token: string,
  groupName: string,
): Promise<Group[]> => {
  const groupsList: Group[] = [];
  try {
    const groups = (await fetchAllPages(
      `${host}/api/v4/groups?all_available=true&search=${groupName}`,
      token,
      'Groups',
    )) as Group[];
    groups.map((group: { id?: string; name?: string; full_path: string }) => {
      const { id, name, full_path } = group;
      if (id && name && full_path) {
        groupsList.push({
          id: group.id,
          name: group.name,
          full_path: group.full_path,
        });
      }
    });
  } catch (err) {
    debug('Failed to retrieve group from Gitlab.\n' + err);
    console.log(
      'Failed to retrieve group from Gitlab. Try running with `DEBUG=snyk* snyk-contributor`',
    );
  }
  return groupsList;
};
