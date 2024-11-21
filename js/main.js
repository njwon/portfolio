let currentSection = 0;
let about = document.querySelector('.about')
let touchStartY = 0; // 터치 시작 Y 좌표
let scrolling = false; // 스크롤 제어 플래그
let currentVideoIndex = 0;
let aaa = 0;

const tape2 = document.querySelectorAll('.tape3');
const tape3 = document.querySelectorAll('.tape2');
const tv = document.querySelectorAll('.tv');
const amain = document.querySelectorAll('.amain')
const skill = document.querySelectorAll('.skill')
const cards = document.querySelectorAll('.cards')
const pright = document.querySelectorAll('.project-right')
const pleft = document.querySelectorAll('.project-left')
const con = document.querySelectorAll('.con')
const sections = document.querySelectorAll('.section');
const totalSections = sections.length;
const computedStyle = window.getComputedStyle(sections[currentSection]);
const height = computedStyle.height; // CSS에서 지정한 높이 가져오기
const Click = 0
const potato = document.querySelectorAll('.potato')
const c = document.querySelectorAll('.c')
const py = document.querySelectorAll('.python')
const right1 = document.querySelectorAll('.right1')
const right2 = document.querySelectorAll('.right2')
const right3 = document.querySelectorAll('.right3')
const nav1 = document.querySelectorAll('.nav1')
const nav2 = document.querySelectorAll('.nav2')
const nav3 = document.querySelectorAll('.nav3')
const mac = document.querySelectorAll('.mac')
const project_left = document.querySelectorAll('.project-left')


const cursorPointed = document.querySelector('.cursor');

const width = window.innerWidth;

if (cursorPointed) {
    const moveCursor = (e) => {
        const mouseY = e.clientY;
        const mouseX = e.clientX;
        cursorPointed.style.left = `${mouseX}px`;
        cursorPointed.style.top = `${mouseY}px`;
    };

    const updateCursorVisibility = () => {
        if (window.innerWidth > 1279) {
            cursorPointed.style.display = 'block';
            window.addEventListener('mousemove', moveCursor);
        } else {
            cursorPointed.style.display = 'none';
            window.removeEventListener('mousemove', moveCursor); // 크기 조정 시 이벤트 제거
        }
    };

    updateCursorVisibility(); // 처음 로드 시 한 번 호출
    window.addEventListener('resize', updateCursorVisibility); // 윈도우 크기 변경 시 호출
}

window.addEventListener('load', () => {
    // 로딩 완료 후 로더 사라지기
    load.style.opacity = '0'; // 투명도 변경
    load.style.zIndex = '10003';

    setTimeout(() => {
        load.style.zIndex = '-1'; // z-index 변경
        load.style.display = 'none'; // 로더 숨기기
    }, 10000); // 애니메이션 시간과 동일하게 설정
});

// 방향키를 통해 currentSection 조절
document.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') {
        // 아래 방향키를 통해 currentSection -1
        if (currentSection < totalSections - 1) {
            currentSection++;
            scrollToSection(currentSection);
        }
    }
    else if (event.key === 'ArrowUp') {
        // 아래 방향키를 통해 currentSection +1
        if (currentSection > 0) {
            currentSection--;
            scrollToSection(currentSection);
        }
    }
});

document.addEventListener('wheel', (event) => {
    if (scrolling) return; // 이미 스크롤 중이라면 무시
    scrolling = true; // 스크롤 시작

    if (event.deltaY > 0) {
        // 아래로 스크롤
        handleScrollDown();
    } else {
        // 위로 스크롤
        handleScrollUp();
    }
});

// 터치 이벤트
document.addEventListener('touchstart', (event) => {
    // 터치 시작 Y 좌표 저장
    touchStartY = event.touches[0].clientY;
});

document.addEventListener('touchend', (event) => {
    const touchEndY = event.changedTouches[0].clientY;
    const touchDifference = touchStartY - touchEndY;

    if (Math.abs(touchDifference) > 30) { // 터치 이동이 충분히 컸을 경우
        if (touchDifference > 0) {
            // 아래로 스크롤
            handleScrollDown();
        } else {
            // 위로 스크롤
            handleScrollUp();
        }
    }
});

function handleScrollDown() {
    if (currentSection === 1) {
        if (about.scrollHeight - about.clientHeight <= about.scrollTop + 5) {
            currentSection++;
            scrollToSection(currentSection);
        }
    } else if (currentSection < totalSections - 1) {
        currentSection++;
        scrollToSection(currentSection);
    }
    scrolling = false; // 스크롤 종료
}

function handleScrollUp() {
    if (currentSection === 1) {
        if (about.scrollTop <= 5) {
            currentSection--;
            scrollToSection(currentSection);
        }
    } else if (currentSection > 0) {
        currentSection--;
        scrollToSection(currentSection);
    }
    scrolling = false; // 스크롤 종료
}

// scrollToSection은 섹션으로 부드럽게 이동하는 함수입니다.
function scrollToSection(sectionIndex) {
    const targetSection = sections[sectionIndex];
    targetSection.scrollIntoView({ behavior: 'smooth' });
}


window.onload = function () {
    // 새로고침시 제일 위로 스크롤
    window.scrollTo(0, 0);
    currentSection = 0;
    scrollToSection(currentSection);
};

// 마지막 섹션에서 스크롤 방지
document.addEventListener('touchmove', (event) => {
    if (currentSection === totalSections - 1) {
        event.preventDefault();
    }
}, { passive: false });


function setSection(index) {
    currentSection = index; // 클릭된 인덱스를 currentSection에 설정
    scrollToSection(currentSection); // 해당 섹션으로 스크롤
}

function scrollToSection(sectionIndex) {
    sections.forEach((section, i) => {
        section.style.transform = `translateY(-${sectionIndex * 100}vh)`; // 섹션 이동

        // 각 섹션에 대해 애니메이션을 추가하거나 제거
        if (i === sectionIndex) {
            // 섹션이 활성화되었을 때 애니메이션 클래스 추가
            section.classList.add('active'); // 예시로 'active' 클래스를 추가
        } else {
            // 섹션이 비활성화되었을 때 애니메이션 클래스 제거
            section.classList.remove('active');
        }
    });

    // 섹션별 애니메이션 추가
    applySectionAnimations(sectionIndex);
}

function applySectionAnimations(sectionIndex) {
    switch (sectionIndex) {
        case 0:
            // 첫 번째 섹션 애니메이션
            tape2.forEach(tape2 => tape2.classList.add("scrollAnimation1"));
            tape3.forEach(tape3 => tape3.classList.add("scrollAnimation2"));
            tv.forEach(tv => tv.classList.add("scrollAnimation3"));
            break;
        case 1:
            // 두 번째 섹션 애니메이션
            amain.forEach(amain => amain.classList.add("scrollAnimation4"));
            break;
        case 2:
            // 세 번째 섹션 애니메이션
            skill.forEach(skill => skill.classList.add("scrollAnimation5"));
            cards.forEach(cards => cards.classList.add("scrollAnimation6"));
            break;
        case 3:
            // 세 번째 섹션 애니메이션
            pright.forEach(pright => pright.classList.add("scrollAnimation7"));
            pleft.forEach(pleft => pleft.classList.add("scrollAnimation8"));
            break;
        case 3:
            // 세 번째 섹션 애니메이션
            con.forEach(con => con.classList.add("scrollAnimation9"));
            break;

        default:
            break;
    }
}

const videos = [
    'img/home/core1.webm',
    'img/home/core2.webm',
    'img/home/core3.webm'
];

function changeVideo() {
    const videoElement = document.getElementById('tvVideo');
    videoElement.pause(); // 현재 영상 멈추기

    // 다음 영상 불러오기
    currentVideoIndex = (currentVideoIndex + 1) % videos.length;
    videoElement.src = videos[currentVideoIndex];
    videoElement.load(); // currentVideoIndex 불러오기

    // 영상 로딩되면 재생
    videoElement.onloadeddata = () => {
        videoElement.play(); // 영상 재생
    };
}

function updateDateTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0'); // 월은 0부터 시작
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const formattedDateTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    document.getElementById('datetime').innerText = formattedDateTime;

    const formattedDateTime2 = `${year}년 ${month}월 ${day}일`;
    document.getElementById('datetime2').innerText = formattedDateTime2;
}

setInterval(updateDateTime, 1000);
updateDateTime(); // 초기 호출

const onScroll = (event) => {
    event.preventDefault();

    if (!isDone) {
        if (event.deltaY > 0) {
            if (currentIndex === texts.length - 1) {
                isDone = true;
                document.body.style.overflow = 'unset';
            } else {
                changeText(1);
            }
        } else {
            if (currentIndex > 0) {
                changeText(-1);
            }
        }
    }
};

const wrap = document.querySelector('.wrap');
const down = document.querySelector('.down');
const card_box = document.querySelector('.card_box');

wrap.addEventListener('click', () => {
    if (window.innerWidth > 767) {
        wrap.classList.toggle('spread');
    }
});

const onTouchStart = (event) => {
    startY = event.touches[0].clientY;
};

const onTouchMove = (event) => {
    const deltaY = startY - event.touches[0].clientY;

    if (!isDone && Math.abs(deltaY) > 50) {
        if (deltaY > 0) {
            if (currentIndex === texts.length - 1) {
                isDone = true;
                document.body.style.overflow = 'unset';
            } else {
                changeText(1);
            }
        } else {
            if (currentIndex > 0) {
                changeText(-1);
            }
        }
        event.preventDefault();
    }
};

function changeText1() {
    if (window.innerWidth > 767) {
        mac.forEach(mac => {
            mac.classList.remove('window');
        });
        mac.forEach(mac => {
            mac.classList.add('window1');
        });
        mac.forEach(mac => {
            mac.classList.remove('window2');
        });
        mac.forEach(mac => {
            mac.classList.remove('window3');
        });
        project_left.forEach(project_left => {
            project_left.classList.remove('black');
        });
        project_left.forEach(project_left => {
            project_left.classList.add('white');
        });
        potato.forEach(potato => {
            potato.classList.remove('none');
            potato.classList.remove('nones');
        });
        nav1.forEach(nav1 => {
            nav1.classList.remove('none');
        });
        c.forEach(c => {
            c.classList.add('none');
            c.classList.add('nones');
        });
        nav2.forEach(nav2 => {
            nav2.classList.add('none');
        });
        py.forEach(py => {
            py.classList.add('none');
            py.classList.add('nones');
        });
        nav3.forEach(nav3 => {
            nav3.classList.add('none');
        });
    }
    else if(window.innerWidth < 767) {
        right1.forEach(right1 => {
            right1.classList.add('nones');
        });
        right2.forEach(right2 => {
            right2.classList.remove('nones');
        });
        right3.forEach(right3 => {
            right3.classList.remove('nones');
        });
    }

}

function changeText2() {
    if (window.innerWidth > 767) {
        mac.forEach(mac => {
            mac.classList.remove('window');
        });
        project_left.forEach(project_left => {
            project_left.classList.remove('black');
        });
        project_left.forEach(project_left => {
            project_left.classList.add('white');
        });
        potato.forEach(potato => {
            potato.classList.add('none');
            potato.classList.add('nones');
        });
        nav1.forEach(nav1 => {
            nav1.classList.add('none');
        });
        mac.forEach(mac => {
            mac.classList.remove('window1');
        });
        c.forEach(c => {
            c.classList.remove('none');
            c.classList.remove('nones');
        });
        nav2.forEach(nav2 => {
            nav2.classList.remove('none');
        });
        mac.forEach(mac => {
            mac.classList.add('window2');
        });
        py.forEach(py => {
            py.classList.add('none');
            py.classList.add('nones');
        });
        nav3.forEach(nav3 => {
            nav3.classList.add('none');
        });
        mac.forEach(mac => {
            mac.classList.remove('window3');
        });
    }

    else if(window.innerWidth < 767) {
        right1.forEach(right1 => {
            right1.classList.remove('nones');
        });
        right2.forEach(right2 => {
            right2.classList.add('nones');
        });
        right3.forEach(right3 => {
            right3.classList.remove('nones');
        });
    }
}

function changeText3() {
    if (window.innerWidth > 767) {
        mac.forEach(mac => {
            mac.classList.remove('window');
        });
        project_left.forEach(project_left => {
            project_left.classList.remove('black');
        });
        project_left.forEach(project_left => {
            project_left.classList.add('white');
        });
        potato.forEach(potato => {
            potato.classList.add('none');
            potato.classList.add('nones');
        });
        nav1.forEach(nav1 => {
            nav1.classList.add('none');
        });
        mac.forEach(mac => {
            mac.classList.remove('window1');
        });
        c.forEach(c => {
            c.classList.add('none');
            c.classList.add('nones');
        });
        nav2.forEach(nav2 => {
            nav2.classList.add('none');
        });
        mac.forEach(mac => {
            mac.classList.remove('window2');
        });
        py.forEach(py => {
            py.classList.remove('none');
            py.classList.remove('nones');
        });
        nav3.forEach(nav3 => {
            nav3.classList.remove('none');
        });
        mac.forEach(mac => {
            mac.classList.add('window3');
        });
    }

    else if(window.innerWidth < 767) {
        right1.forEach(right1 => {
            right1.classList.remove('nones');
        });
        right2.forEach(right2 => {
            right2.classList.remove('nones');
        });
        right3.forEach(right3 => {
            right3.classList.add('nones');
        });
    }
}

function changeText4() {
    mac.forEach(mac => {
        mac.classList.add('window');
    });
    project_left.forEach(project_left => {
        project_left.classList.add('black');
    });
    project_left.forEach(project_left => {
        project_left.classList.remove('white');
    });
    potato.forEach(potato => {
        potato.classList.add('none');
    });
    nav1.forEach(nav1 => {
        nav1.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window1');
    });
    c.forEach(c => {
        c.classList.add('none');
    });
    nav2.forEach(nav2 => {
        nav2.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window2');
    });
    py.forEach(py => {
        py.classList.add('none');
    });
    nav3.forEach(nav3 => {
        nav3.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window3');
    });
}

// if(currentSection === 0) {
//     tape2.forEach(tape2 => {
//         tape2.classList.add("scrollAnimation1");
//     });
//     tape3.forEach(tape3 => {
//         tape3.classList.add("scrollAnimation2");
//     });
//     tv.forEach(tv => {
//         tv.classList.add("scrollAnimation3");
//     });
// }
// else if(currentSection === 1) {
//     console.log('Section 1 reached');
//     amain.forEach(amain => {
//         console.log('Adding animation class to amain');
//         amain.classList.add("scrollAnimation4");
//     });
// }
// else if(currentSection === 2) {
//     skill.forEach(skill => {
//         skill.classList.add("scrollAnimation4");
//     });
// }
