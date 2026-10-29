update public.matches
set team_a = replace(team_a, U&'Fort\00c3\00adn', U&'Fort\00edn'),
    team_b = replace(team_b, U&'Fort\00c3\00adn', U&'Fort\00edn')
where team_a like '%Fort%' or team_b like '%Fort%';
